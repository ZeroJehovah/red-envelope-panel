/* hb.unsnow.org 红包口令面板：后台 service worker。
 *
 * 职责：唯一状态副本、消息路由、hb.unsnow.org 请求代理、限速与队列。
 * 与脚本版一致的关键语义：
 *   - 请求只由后台发出，携带 hb.unsnow.org 会话 Cookie（credentials: 'include'）；
 *   - 限速时间戳落在 chrome.storage.local，worker 被回收后仍然生效；
 *   - 领取必须是真实点击授权后的一次性请求，发出后不自动重试；
 *   - 古法查到可领的红包后自动弹出领取卡片（脚本版 showClaimEnvelope / showLotteryEnvelope
 *     的对应物），领取仍然只认卡片上的真实点击；
 *   - 抽奖报名后停在 awaiting，由开奖看护按 id 只读轮询到开奖；
 *   - 删除按 ID 墓碑，写入按 ID 合并，绝不整体覆盖历史。
 *
 * MV3 提示：worker 空闲即休眠，内存变量不可跨唤醒保留，因此状态读回与限速时间戳都以
 * chrome.storage.local 为准；定时器只负责“唤醒后尽快执行”，不承担正确性。
 */
'use strict';

importScripts('browser-shim.js', 'code-rules.js', 'hb-protocol.js', 'card-window.js');

const api = globalThis.HBApi;
const P = globalThis.HBProtocol;
const codes = globalThis.HBCodes;
const VERSION = api.runtime.getManifest().version;

const STATE_KEY = 'hb-state-v1';
const TICK_ALARM = 'hb-queue-tick';
const TICK_ALARM_MINUTES = 0.5;      // 定时器丢失后的兜底唤醒；精度由内存定时器保证
const WAIT_SLICE_MS = 30000;         // 单次等待上限，到点重新计算
const REMOVED_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const REMOVED_MAX_ENTRIES = 1000;

const CLAIM_MODES = ['manual', 'direct', 'dynamic'];
const CLAIM_METRIC_TEXT = { total: '总额', average: '人均' };

const DEFAULT_SETTINGS = Object.freeze({
  charset: 'text',       // 'text'：6-18 字符文本口令；'numeric'：8 位数字口令
  batch: false,          // false：单个口令；true：批量口令（每行一条）
  // 'manual'：古法，面板内点击开启；'direct'：协议，后台直接领取；
  // 'dynamic'：动态，口令查到红包之后按下面的指标与阈值决定走协议还是古法。
  claimMode: 'manual',
  claimMetric: 'total',  // 'total'：按总额判定；'average'：按人均（总额 ÷ 个数／抽选人数）判定
  claimThreshold: 0,     // 动态模式的门槛：判定量 ≥ 它就走协议；默认 0 等于都走协议
  gapExtraMs: 0,         // 在 5 秒基础间隔之上追加的等待时间
  display: 'panel',      // 'panel'：点图标弹出面板；'sidebar'：常显侧边栏
});

function normalizeClaimMode(value) {
  return CLAIM_MODES.includes(value) ? value : 'manual';
}

function emptyState() {
  return {
    entries: [],
    removed: [],
    settings: { ...DEFAULT_SETTINGS },
    paused: false,
    pausedReason: '',
    lastFinishedAt: 0,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // 落到下面的计数式 ID。
  }
  return 'e' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* --------------------------------- 状态层 --------------------------------- */

// 一条口令从入队到落到历史的全过程；字段与脚本版 normalizeEntry 对齐。
//
// 「待开启」不是一条待发的请求，而是「卡片已经摆出来、等着点一下」这个状态。脚本版把它按页面
// 重载处理（重查一遍口令、卡片摆回来），扩展里 worker 被回收再唤醒是几十秒一次的常态，照做
// 的代价是唤醒时把限速刻度顶到「刚刚」（刚提交的口令于是显示「排队中」）并从古法那边把领取
// 卡片一遍遍弹回来（v0.11.1 修）。快照与 packetId 都落了库，这里就让待开启的条目原地待着；
// 只有连快照都没有的老记录（画不出卡片）才回队列重新查询。
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code) return null;
  const statuses = ['queued', 'awaiting', 'running', 'done', 'failed', 'void'];
  const startedAt = Number(raw.startedAt);
  const finishedAt = Number(raw.finishedAt);
  // 重载无法知道被打断的请求结果，按脚本版语义记为失败并写明“结果未确认”。
  const interrupted = raw.status === 'running';
  const lines = P.normalizeLines(raw.lines);
  const packet = isPlainObject(raw.packet) ? raw.packet : null;
  const watchUntil = Number(raw.watchUntil);
  const restorableWatch = Number.isFinite(watchUntil) && watchUntil > 0;
  const deferred = raw.status === 'awaiting' && typeof packet?.id === 'string' && Boolean(packet.id);
  // 已报名的抽奖还要把开奖看护装回来：收摊时刻落了库就按它接着按 id 轮询（不进限速），老记录
  // 没有这个字段时才回队列重查一次口令，查到 joined 就把收摊时刻补齐。
  const watching = deferred && P.isLottery(packet) && packet.joined === true;
  const awaiting = deferred && (!watching || restorableWatch);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    code: raw.code,
    // 领取方式在提交时固定（脚本版同语义）：只认存下来的值，不按状态改写。
    // 存的是 'dynamic' 时也原样留着，查到红包后由 resolveClaimMode 落成 manual/direct。
    claimMode: normalizeClaimMode(raw.claimMode),
    packetId: typeof raw.packetId === 'string' && raw.packetId ? raw.packetId : null,
    matched: P.hasMatchedPacket(raw),
    charset: raw.charset === 'numeric' ? 'numeric' : 'text',
    status: awaiting ? 'awaiting'
      : (raw.status === 'awaiting' ? 'queued' : (interrupted ? 'failed' : (statuses.includes(raw.status) ? raw.status : 'failed'))),
    result: interrupted ? P.INTERRUPTED_RESULT : (typeof raw.result === 'string' ? raw.result : ''),
    // 待开启的条目不再重查，它那几行结果（匹配到的祝福、「等待手动开启」等）原样留着。
    lines: interrupted ? null : lines,
    packet,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: interrupted ? Date.now() : (Number.isFinite(finishedAt) ? finishedAt : null),
    // 开奖看护的收摊时刻落库（绝对时刻，服务器钟偏已在写入时算掉）；下次轮询时刻按唤醒时间重排。
    watchUntil: awaiting && restorableWatch ? watchUntil : null,
    scheduledAt: null,
  };
}

// 与 normalizeEntry 相同，但用于合并 storage 里已有的行：绝不把 running 降级成失败，
// 那条请求还在别的实例手里，结果由它自己写回。
function preserveEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code) return null;
  const statuses = ['queued', 'awaiting', 'running', 'done', 'failed', 'void'];
  const startedAt = Number(raw.startedAt);
  const finishedAt = Number(raw.finishedAt);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    code: raw.code,
    claimMode: normalizeClaimMode(raw.claimMode),
    packetId: typeof raw.packetId === 'string' && raw.packetId ? raw.packetId : null,
    matched: P.hasMatchedPacket(raw),
    charset: raw.charset === 'numeric' ? 'numeric' : 'text',
    status: statuses.includes(raw.status) ? raw.status : 'failed',
    result: typeof raw.result === 'string' ? raw.result : '',
    lines: P.normalizeLines(raw.lines),
    packet: isPlainObject(raw.packet) ? raw.packet : null,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: Number.isFinite(finishedAt) ? finishedAt : null,
    watchUntil: Number.isFinite(Number(raw.watchUntil)) && Number(raw.watchUntil) > 0 ? Number(raw.watchUntil) : null,
    scheduledAt: null,
  };
}

function normalizeRemoved(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      id: typeof item?.id === 'string' && item.id ? item.id : null,
      at: Number.isFinite(Number(item?.at)) ? Number(item.at) : 0,
    }))
    .filter((item) => item.id);
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(isPlainObject(raw) ? raw : {}) };
  return {
    charset: merged.charset === 'numeric' ? 'numeric' : 'text',
    batch: merged.batch === true,
    claimMode: normalizeClaimMode(merged.claimMode),
    claimMetric: merged.claimMetric === 'average' ? 'average' : 'total',
    claimThreshold: P.clampThreshold(merged.claimThreshold),
    gapExtraMs: P.clampGapExtra(merged.gapExtraMs),
    display: merged.display === 'sidebar' ? 'sidebar' : 'panel',
  };
}

function normalizeState(raw) {
  const loaded = emptyState();
  if (!isPlainObject(raw)) return loaded;
  loaded.settings = normalizeSettings(raw.settings);
  loaded.paused = Boolean(raw.paused);
  loaded.pausedReason = typeof raw.pausedReason === 'string' ? raw.pausedReason : '';
  // 限速刻度是「上一次请求结束」的时刻。旧版本记的是开始时刻，迁移时取两者较大的
  // 那个：只会让下一次请求多等一会儿，不会提前发出。
  const finished = Number(raw.lastFinishedAt);
  const legacyStarted = Number(raw.lastStartedAt);
  loaded.lastFinishedAt = Math.max(
    Number.isFinite(finished) ? finished : 0,
    Number.isFinite(legacyStarted) ? legacyStarted : 0,
  );
  // 上次运行被打断在请求中途：那条请求的结果与结束时刻都无从得知，保守地按「刚刚结束」
  // 起算，唤醒后的第一条请求再等满一个间隔。
  if ((Array.isArray(raw.entries) ? raw.entries : []).some((item) => item?.status === 'running')) {
    loaded.lastFinishedAt = Math.max(loaded.lastFinishedAt, Date.now());
  }
  loaded.entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .slice(-P.MAX_HISTORY_ENTRIES);
  loaded.removed = normalizeRemoved(raw.removed);
  if (loaded.removed.length) {
    const gone = new Set(loaded.removed.map((item) => item.id));
    loaded.entries = loaded.entries.filter((entry) => !gone.has(entry.id));
  }
  // 已报名、还没开奖的抽奖：唤醒后不重查口令，按落库的收摊时刻把看护直接装回来（按 id 只读
  // 的一轮轮询在 tick 里进行，不进限速）。下一次轮询时刻不落库，这里按唤醒时间重排。
  const wakeAt = Date.now();
  for (const entry of loaded.entries) {
    if (entry.status === 'awaiting' && Number.isFinite(entry.watchUntil)
      && P.isLottery(entry.packet) && entry.packet.joined === true) {
      entry.watchNextAt = wakeAt;
    }
  }
  return loaded;
}

// 内存副本在 worker 存活期间是工作副本；每个消息进来先确保它已加载。
let state = null;
let loading = null;

async function getState() {
  if (state) return state;
  if (!loading) {
    loading = api.storage.local.get(STATE_KEY).then((bag) => normalizeState(bag?.[STATE_KEY]));
  }
  state = await loading;
  loading = null;
  return state;
}

function snapshot() {
  return {
    entries: state.entries,
    removed: state.removed,
    settings: state.settings,
    paused: state.paused,
    pausedReason: state.pausedReason,
    lastFinishedAt: state.lastFinishedAt,
  };
}

// 写入从不是整体覆盖：读回 storage 后按 id 合并，墓碑永远优先，
// 超出上限的历史就地打成墓碑，老墓碑按 30 天清理。
async function commit() {
  const bag = await api.storage.local.get(STATE_KEY);
  const stored = isPlainObject(bag?.[STATE_KEY]) ? bag[STATE_KEY] : null;

  const removedAt = new Map();
  const noteRemoved = (list) => {
    for (const item of normalizeRemoved(list)) {
      const known = removedAt.get(item.id);
      if (known === undefined || item.at >= known) removedAt.set(item.id, item.at);
    }
  };
  noteRemoved(stored?.removed);
  noteRemoved(state.removed);

  const byId = new Map();
  for (const entry of (Array.isArray(stored?.entries) ? stored.entries : []).map(preserveEntry).filter(Boolean)) {
    byId.set(entry.id, entry);
  }
  // 后台是唯一写入者：内存里更新的同 id 覆盖旧副本，其余条目原样保留。
  for (const entry of state.entries) byId.set(entry.id, entry);

  const entries = [...byId.values()]
    .filter((entry) => !removedAt.has(entry.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  const stamp = Date.now();
  if (entries.length > P.MAX_HISTORY_ENTRIES) {
    for (const entry of entries.splice(0, entries.length - P.MAX_HISTORY_ENTRIES)) removedAt.set(entry.id, stamp);
  }

  const removed = [...removedAt.entries()]
    .filter(([, at]) => stamp - at < REMOVED_MAX_AGE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, REMOVED_MAX_ENTRIES)
    .map(([id, at]) => ({ id, at }));

  state.entries = entries;
  state.removed = removed;
  state.settings = normalizeSettings(state.settings);
  await api.storage.local.set({ [STATE_KEY]: snapshot() });
  return state;
}

/* -------------------------------- 请求代理 -------------------------------- */

// 站点的写接口只认自己那一个 Origin：扩展发出的 POST 带着
// Origin: chrome-extension://<id>，会被回 403「请求来源不合法」。
// rules.json 里的静态声明式规则把 /api/ 请求的 Origin 与 Referer 改写成站点来源
// （对站点自己页面发出的请求就是原值，等于没有副作用），只读的 GET 不受影响。
async function siteRequest(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), P.REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      cache: 'no-store',
      // 与脚本版一致：POST 只声明 JSON，GET 只要 JSON。
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null; // 响应不是 JSON 时按脚本版 responseType:'json' 的行为留空。
    }
    return { status: response.status, response: data };
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? '请求超时' : '网络失败，请检查登录或网络状态');
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gapMs() {
  return P.GAP_BASE_MS + P.clampGapExtra(state.settings.gapExtraMs);
}

// 限速只针对「口令查询」这条接口——脚本版 sharedQuery 管的正是它：刻度记「上一次口令查询
// 结束」的时刻，下一次口令查询从这一刻起再等满一个间隔。刻度改成「结束」而不是「开始」是
// 因为站点的冷却从它处理完上一次请求起算；刻度落在 storage，worker 被回收也不会提前发出。
//
// 按 id 只读（开奖看护轮询、详情读取）与 /api/me 不进这条节奏：既不等间隔，也不刷新刻度，
// 与脚本版里那几处裸 request 一致。扩展一度把这几种只读也塞进限速，代价是后台为一个待开奖
// 的抽奖每 5 秒轮询一次、把刻度一直顶在「刚刚」：用户闲置再久，提交一条口令也要排在后面显示
// 「排队中」（v0.11.0 修，见 docs/AGENTS.md 的限速一节）。
//
// 领取的那次 POST 同样不进这条节奏（v0.12.1）：间隔是给「输入口令」这条接口定的，古法由
// 点击触发，点下去就当场发出去，既不等间隔也不刷新刻度——正与按 id 只读同一种待遇。
function gapRemainingMs() {
  const last = Number(state.lastFinishedAt) || 0;
  if (last > Date.now()) throw new Error('系统时钟早于共享时间戳，未发送请求');
  return Math.max(0, gapMs() - (Date.now() - last));
}

// 等到「上一次口令查询结束」满一个间隔。一次操作里连发的请求只在开始前等一次，期间不刷新
// 刻度，所以协议模式的「查询 + 领取」依旧是一条挨着一条。
async function waitForGap() {
  for (;;) {
    const wait = gapRemainingMs();
    if (wait <= 0) return;
    await sleep(Math.min(wait, WAIT_SLICE_MS));
  }
}

// 一次口令查询结束就是新刻度的起点：成功、失败、超时都算结束。
async function markSettled() {
  state.lastFinishedAt = Date.now();
  try {
    await commit();
  } catch {
    // 落盘失败不影响本轮判断：内存里的刻度已经生效，下一次请求照样按它等。
  }
}

// 一条口令的「查询 + 领取」算一次操作：从等间隔开始，到它最后一次请求结束为止。走这条路的是
// 队列里的口令查询——协议模式的领取跟在同一次操作里，所以它也不额外多等一个间隔。
async function withQueryGap(task) {
  await waitForGap();
  try {
    return await task();
  } finally {
    await markSettled();
  }
}

// 只读查询本身不参与限速：口令查询由外层操作等间隔，按 id 只读则完全不等。
const siteQuery = (url) => siteRequest(url, 'GET');

let sessionPromise = null;

async function packetSession() {
  if (!sessionPromise) {
    sessionPromise = siteRequest(P.sessionUrl(), 'GET')
      .then((response) => {
        const user = response.status === 200 && response.response?.user;
        if (!user) sessionPromise = null;
        return user ? { username: user.username, linuxdo_id: user.linuxdo_id } : null;
      })
      .catch(() => {
        sessionPromise = null;
        return null;
      });
  }
  return sessionPromise;
}

/* ------------------------------ 红包详情快照 ------------------------------ */

// 面板的详情卡片要的是原始红包（含领取记录 claims、参与者 participants、中奖名单 winners），
// 这些字段按约定不入库，只在当前这轮 worker 里留一份内存副本；worker 被回收后由面板
// 按 id 重新读一次红包本身（只读 GET，与队列、看护共用同一份限速节奏）。
const livePackets = new Map();

function rememberPacket(packet) {
  if (!P.validPacket(packet)) return null;
  livePackets.set(String(packet.id), packet);
  return packet;
}

/* --------------------------------- 领取 -------------------------------- */

// 动态模式的判定：口令查到红包之后才谈得上比大小（总额／人均都来自站点回包）。达标走
// 协议，不达标转古法；判定量取不到（红包没有金额或人数）也按古法——宁可让用户自己点
// 一下，也不要自动发出写请求。判定结果落回 entry.claimMode（'dynamic' 对这条记录到此
// 为止），因此领取卡片与 handleClaim 的校验仍旧只认 manual/direct。
//
// 指标与阈值读的是「领取这一刻」的设置，不是提交那一刻的快照：队列里还没轮到的口令跟着
// 最新设置走，用户调完阈值不必重新提交。
function resolveClaimMode(entry, packet) {
  if (entry.claimMode !== 'dynamic') {
    return { mode: entry.claimMode === 'direct' ? 'direct' : 'manual', note: [] };
  }
  const metric = state.settings.claimMetric === 'average' ? 'average' : 'total';
  const threshold = P.clampThreshold(state.settings.claimThreshold);
  const value = P.packetMetricValue(packet, metric);
  const pass = Number.isFinite(value) && value >= threshold;
  entry.claimMode = pass ? 'direct' : 'manual';
  const note = P.line('动态：' + CLAIM_METRIC_TEXT[metric] + ' '
    + (Number.isFinite(value) ? value.toFixed(2) + ' LDC' : '未知')
    + (pass ? ' ≥ ' : ' < ') + '阈值 ' + threshold.toFixed(2)
    + (pass ? '，自动协议领取' : '，转古法手动开启'), 'muted');
  return { mode: entry.claimMode, note: [note] };
}

// 正在领取的条目：一次点击只放行一条请求，重复点击在这里被挡掉。
const claiming = new Set();

// extraLines：动态模式在领取前写的判定说明，接在匹配行之后、领取进度行之前，
// 领取结果里也留着——事后能看清这一次为什么走了协议。
async function claimPacket(entry, packet, extraLines = []) {
  const match = P.matchLines(packet);
  if (claiming.has(entry.id)) {
    return { lines: match.concat(P.line('领取失败: 该口令正在处理中，未发送领取请求', 'error')) };
  }
  claiming.add(entry.id);
  let sent = false;
  try {
    // 发出前先落状态：请求一旦发出，结果未确认时历史里必须有痕迹。这一次 POST 不进口令
    // 查询的间隔（v0.12.1）——点「开」就当场发，条目在 claiming 里挡住重复点击，一次
    // 点击依旧只放行一次请求。
    entry.status = 'running';
    entry.lines = match.concat(extraLines, P.line('正在开启红包…', 'muted'));
    entry.result = P.linesText(entry.lines);
    await commit();
    sent = true;
    const response = await siteRequest(P.grabUrl(packet.id), 'POST');
    const receipt = P.claimReceipt(response, packet);
    // 抽奖回执里带着刷新过的红包（含参与者名单），详情卡片直接读这一份。
    if (P.validPacket(receipt.packet)) rememberPacket(receipt.packet);
    // 抽奖报名成功不是终局：条目停在 awaiting，由开奖看护轮询到开奖。
    if (receipt.joined) entry.packet = P.packetSnapshot(receipt.packet || { ...packet, joined: true });
    return { ...receipt, awaiting: receipt.joined === true, lines: match.concat(extraLines, receipt.lines) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '请求失败';
    return {
      lines: match.concat(P.line('领取失败: ' + reason
        + (sent ? '；结果未确认，请到红包站核对，不会自动重试' : ''), 'error')),
      pause: true,
    };
  } finally {
    claiming.delete(entry.id);
  }
}

// 古法：口令查到可领的红包之后，卡片自己弹出来（脚本版 runEntry / runLotteryEntry 里的
// showClaimEnvelope / showLotteryEnvelope）。扩展里没有可以贴卡片的网页，对应物就是把领取卡片
// 开进详情窗口——窗口里只有这一张卡，领取仍然只认卡片上的真实点击（envelope.js 校验
// event.isTrusted），后台再校验条目状态。弹不出来（比如环境根本不支持开窗）不影响队列与历史，
// 只是要用户自己点历史行走一趟。
function popClaimCard(entry) {
  if (!entry?.packet?.id) return;
  const cardWindow = globalThis.HBCardWindow;
  if (!cardWindow) return;
  Promise.resolve(cardWindow.open({ id: entry.id, entry, packet: entry.packet, view: 'claim' }))
    .then((result) => {
      if (result?.ok === false) console.warn('[红包口令面板] 自动弹出红包卡片失败：' + result.error);
    })
    .catch(() => {});
}

async function runEntry(entry) {
  const response = await siteQuery(P.queryUrl(entry.code, entry.charset));
  const outcome = P.queryOutcome(response);
  if (!outcome.matched) return outcome;

  const packet = outcome.packet;
  entry.packetId = String(packet.id);
  entry.matched = true;
  entry.packet = P.packetSnapshot(packet);
  rememberPacket(packet);
  await commit();

  const user = await packetSession();
  // 抽奖有自己的时钟：报名一次，钱等服务器在 draw_at 开奖，所以不套普通红包的终局判定。
  if (P.isLottery(packet)) return runLotteryEntry(entry, packet, user);

  const decision = P.packetOutcome(packet, user);
  // 不可领取的红包只更新历史，详情由面板按需展开。
  if (decision) return decision;

  // 领取方式在提交时固定：改设置不会自动开启已经查到的红包。动态模式要等红包查回来才
  // 谈得上判定（总额／人均都来自站点回包），判定就落在这一处。
  const resolved = resolveClaimMode(entry, packet);
  if (resolved.mode !== 'direct') {
    const lines = P.matchLines(packet).concat(resolved.note, P.line(P.AWAIT_MANUAL_LINE, 'muted'));
    entry.status = 'awaiting';
    entry.lines = lines;
    entry.result = P.linesText(lines);
    await commit();
    popClaimCard(entry);
    return { awaiting: true, lines };
  }
  return claimPacket(entry, packet, resolved.note);
}

// 抽奖红包：/grab 只是报名，钱等服务器在 draw_at 开奖。报名成功后看护的收摊时刻落库
// （settle 里写 entry.watchUntil），唤醒时按它直接装回来；缺这个字段的老记录才回到队列
// 重查一次口令、看到 joined 再补齐（v0.11.1）。
async function runLotteryEntry(entry, packet, user) {
  const match = P.matchLines(packet);
  // 已经抽完（或不再可参与）的抽奖是终局，判定与历史行共用 packetOutcome。
  if (packet.status !== 'active' || packet.drawn_at) return P.packetOutcome(packet, user);
  if (P.isPacketCreator(packet, user)) {
    return {
      title: '这是你发出的红包',
      amount: packet.claimed_amount || 0,
      detail: '口令 ' + (packet.code || entry.code),
      lines: match.concat(P.line('未参与: 这是你发出的红包', 'muted')),
    };
  }
  if (packet.joined) {
    return { awaiting: true, lines: match.concat(P.line(P.LOTTERY_JOINED_LINE, 'success')) };
  }
  // 站点要求它自己的会话，没登录就不发报名请求。
  if (!user) {
    return {
      title: '请先登录红包站',
      amount: 0,
      detail: '未确认红包站登录状态，请到红包站登录后再试',
      lines: match.concat(P.line('未参与: 未确认红包站登录状态，请到红包站登录后再试', 'muted')),
    };
  }
  // 抽奖的「领」就是报名，动态模式的判定与普通红包同一条路子：达标直接报名，否则弹卡片
  // 等用户点「参与抽选」。
  const resolved = resolveClaimMode(entry, packet);
  if (resolved.mode !== 'direct') {
    const lines = match.concat(resolved.note, P.line(P.LOTTERY_AWAIT_LINE, 'muted'));
    entry.status = 'awaiting';
    entry.lines = lines;
    entry.result = P.linesText(lines);
    await commit();
    popClaimCard(entry);
    return { awaiting: true, lines };
  }
  return claimPacket(entry, packet, resolved.note);
}

/* --------------------------------- 队列 -------------------------------- */

let timer = null;
let executing = false;

// 队列推进失败（例如 worker 正好被回收、浏览器正在关闭）不算错误：
// 状态与限速时间戳都在 storage 里，下一次唤醒（消息或 alarm）重新读回继续跑。
function scheduleTick() {
  tick().catch(() => {});
}

function queuedEntries() {
  return state.entries.filter((entry) => entry.status === 'queued');
}

// 每条排队口令都保留计划开始时间：作废队首不会在时间表上留洞。
function planQueue() {
  const gap = gapMs();
  let cursor = Math.max(Date.now(), state.lastFinishedAt ? state.lastFinishedAt + gap : 0);
  for (const entry of state.entries) {
    if (entry.status === 'running') {
      cursor = Math.max(cursor, (entry.startedAt || Date.now()) + gap);
      entry.scheduledAt = null;
    } else if (entry.status === 'queued') {
      entry.scheduledAt = cursor;
      cursor += gap;
    } else {
      entry.scheduledAt = null;
    }
  }
}

function clearTimer() {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

async function syncAlarm() {
  if (!api.alarms) return;
  // 队列要跑，或者还有抽奖在等开奖，都需要心跳兜底（worker 被回收后靠它接着跑）。
  const pending = (!state.paused && state.entries.some((entry) => entry.status === 'queued'))
    || watchedEntries().length > 0;
  if (pending) {
    await api.alarms.create(TICK_ALARM, { delayInMinutes: TICK_ALARM_MINUTES, periodInMinutes: TICK_ALARM_MINUTES });
  } else {
    await api.alarms.clear(TICK_ALARM);
  }
}

async function tick() {
  await getState();
  clearTimer();
  if (executing) return;
  planQueue();
  // 队列优先：查询与领取排在前面，队列空下来才轮询开奖，两者共用同一份限速节奏。
  const next = state.paused ? null : state.entries.find((entry) => entry.status === 'queued');
  const watch = next ? null : watchedEntries()[0];
  if (!next && !watch) {
    await syncAlarm();
    return;
  }
  const delay = next
    ? Math.max(0, (next.scheduledAt || 0) - Date.now())
    : Math.max(0, (Number(watch.watchNextAt) || 0) - Date.now());
  await syncAlarm();
  if (delay > 0) {
    timer = setTimeout(() => {
      timer = null;
      scheduleTick();
    }, Math.min(delay, WAIT_SLICE_MS));
    return;
  }
  if (next) executeEntry(next).catch(() => {});
  else watchEntry(watch).catch(() => {});
}

// 一条口令的终局：awaiting 停在等待点击，pause 表示不该让队列继续往下跑。
async function settle(entry, outcome) {
  entry.status = outcome.awaiting ? 'awaiting' : (outcome.pause ? 'failed' : 'done');
  entry.lines = outcome.lines || null;
  entry.result = P.linesText(entry.lines);
  entry.finishedAt = outcome.awaiting ? null : Date.now();
  entry.scheduledAt = null;
  // 报名过的抽奖进看护：收摊时刻按绝对时刻落库（服务器钟偏已在写入时算掉），worker
  // 被回收后按它直接装回来；内存里的轮询节奏与定时器本来就不落库。
  if (entry.status === 'awaiting' && P.isLottery(entry.packet) && entry.packet.joined === true) {
    entry.watchUntil = P.watchDeadline(entry.packet, Date.now());
    entry.watchNextAt = Date.now();
  } else {
    entry.watchUntil = null;
    entry.watchNextAt = null;
  }
  if (outcome.pause) {
    state.paused = true;
    state.pausedReason = entry.result;
  }
  await commit();
}

async function executeEntry(entry) {
  executing = true;
  let outcome;
  try {
    entry.status = 'running';
    entry.startedAt = Date.now();
    entry.lines = [P.line('正在查询…', 'muted')];
    entry.result = '';
    await commit();
    // 一条口令的「查询 + 领取」算一次操作：从等间隔开始，到最后一次请求结束为止。
    outcome = await withQueryGap(() => runEntry(entry));
  } catch (error) {
    outcome = {
      lines: [P.line('查询失败: ' + (error instanceof Error ? error.message : '请求失败') + '。请手动再试。', 'error')],
      pause: true,
    };
  } finally {
    // 中途哪一步抛错都要松开队列：executing 卡住会让后面每一条口令都停在「排队中」。
    executing = false;
  }
  try {
    await settle(entry, outcome);
  } catch {
    // 写回失败不改内存里的结论：下一次唤醒按内存与 storage 合并后的结果继续。
  }
  if (!state.paused) scheduleTick();
}

/* ------------------------------- 开奖看护 ------------------------------- */

// 报名过的抽奖条目都算看护对象：等到 draw_at，过了点再等 DRAW_WATCH_LIMIT_MS。
// 看护只读红包本身（GET），不发任何写请求，所以被删除或作废时不会留下半条记录。
function watchedEntries() {
  return state.entries.filter((entry) => entry.status === 'awaiting'
    && P.isLottery(entry.packet) && entry.packet.joined === true
    && typeof entry.packet.id === 'string' && entry.packet.id);
}

async function watchEntry(entry) {
  executing = true;
  let settled = false;
  try {
    const packetId = String(entry.packet.id);
    let fresh = null;
    try {
      // 看护轮询是一处裸的按 id 只读（脚本版 watchLotteryDraw 里的 request(id, 'GET')）：
      // 不等口令查询的间隔、也不刷新刻度，节奏由 DRAW_POLL_INTERVAL_MS 决定。
      const response = await siteQuery(P.packetUrl(packetId));
      fresh = response.status === 200 ? response.response : null;
      // 看护每轮读回的红包就是最新的详情，顺手更新内存副本供面板读取。
      if (P.validPacket(fresh) && String(fresh.id) === packetId) rememberPacket(fresh);
    } catch {
      // 查询失败不结束看护：下一次心跳接着试，直到收摊时刻。
    }
    // 条目可能在等网络时被删掉或作废：那时什么都不要写回去。
    if (!state.entries.some((item) => item.id === entry.id)) return;
    if (P.validPacket(fresh) && String(fresh.id) === packetId
      && (fresh.drawn_at || fresh.status !== 'active')) {
      const user = await packetSession();
      const outcome = P.packetOutcome(fresh, user);
      if (outcome) {
        entry.packet = P.packetSnapshot(fresh);
        await settle(entry, outcome);
        settled = true;
      }
    }
  } finally {
    executing = false;
  }
  if (!settled) {
    if (Date.now() >= Number(entry.watchUntil)) {
      await settle(entry, { lines: P.matchLines(entry.packet).concat(P.line(P.DRAW_UNCONFIRMED, 'error')) });
    } else {
      entry.watchNextAt = Date.now() + P.DRAW_POLL_INTERVAL_MS;
    }
  }
  if (!state.paused) scheduleTick();
}

async function voidEntry(id) {
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!entry || !['queued', 'awaiting'].includes(entry.status)) return state;
  entry.status = 'void';
  entry.lines = [P.line('已作废', 'muted')];
  entry.result = '已作废';
  entry.finishedAt = Date.now();
  entry.scheduledAt = null;
  await commit();
  await tick();
  return state;
}

// 删除是把 id 打成墓碑：即使别处还留着旧副本，也不会把它写回来。
async function deleteEntry(id) {
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!entry || entry.status === 'running' || claiming.has(id)) return state;
  state.removed = state.removed.concat({ id, at: Date.now() });
  state.entries = state.entries.filter((candidate) => candidate.id !== id);
  await commit();
  return state;
}

async function voidAllQueued() {
  const queued = queuedEntries();
  if (!queued.length) return state;
  const stamp = Date.now();
  for (const entry of queued) {
    entry.status = 'void';
    entry.lines = [P.line('已作废', 'muted')];
    entry.result = '已作废';
    entry.finishedAt = stamp;
    entry.scheduledAt = null;
  }
  await commit();
  await tick();
  return state;
}

// 清空覆盖整份共享历史；正在领取或正在查询的条目留下，等它自己把结果写回。
async function clearHistory() {
  const stamp = Date.now();
  const kept = [];
  for (const entry of state.entries) {
    if (entry.status === 'running' || claiming.has(entry.id)) {
      kept.push(entry);
      continue;
    }
    state.removed = state.removed.concat({ id: entry.id, at: stamp });
  }
  state.entries = kept;
  await commit();
  await tick();
  return state;
}

async function resumeQueue() {
  if (!state.paused) return state;
  state.paused = false;
  state.pausedReason = '';
  await commit();
  scheduleTick();
  return state;
}

/* ------------------------------- 消息处理 ------------------------------- */

// 面板点一次“开”只发一条 hb:claim：面板负责校验真实点击（event.isTrusted），
// 后台负责校验条目状态。状态在请求发出前就改掉，所以第二次点击必然被挡下。
async function handleClaim(message) {
  const id = typeof message?.id === 'string' ? message.id : '';
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!entry) return { ok: false, error: '该口令已清空或已在其他面板处理，未发送领取请求' };
  if (message?.trusted !== true) return { ok: false, error: '缺少有效的领取授权，未发送领取请求' };
  if (entry.status !== 'awaiting') return { ok: false, error: '领取模式或红包状态已改变，未发送领取请求' };
  if (!entry.packet?.id || entry.claimMode !== 'manual') {
    return { ok: false, error: '该口令没有可手动开启的红包，未发送领取请求' };
  }
  const outcome = await claimPacket(entry, entry.packet);
  await settle(entry, outcome);
  if (!state.paused) scheduleTick();
  // 回执与刷新过的红包一起回给面板：详情卡片据此渲染金额、进度与领取记录。
  const key = String(entry.packet?.id || '');
  return { ok: true, state: snapshot(), outcome, packet: livePackets.get(key) || null };
}

// 红包详情：详情窗口打开卡片时按 id 读红包本身。内存里有（刚查询过、刚拿到领取回执、看护刚
// 轮询过）就直接用，省掉一次请求；没有或要求 refresh 时才补一次网络查询（按 id 只读，不进
// 限速）。cacheOnly 只问内存、绝不发请求：详情窗口靠它决定「直接铺卡片」还是「先挂一层
// loading 等这次只读查询」。这里永远是 GET。
async function readPacket(id, options = {}) {
  const key = String(id || '');
  if (!key) return { ok: false, error: '缺少红包 ID' };
  let packet = livePackets.get(key) || null;
  if (!packet && options.cacheOnly === true) return { ok: false, error: '内存里没有这个红包的快照' };
  if (!packet || options.refresh === true) {
    try {
      // 详情刷新是裸的按 id 只读（脚本版 openEnvelopeCard 里那次 request(id, 'GET')）。
      const response = await siteQuery(P.packetUrl(key));
      const fresh = response.status === 200 && P.validPacket(response.response)
        && String(response.response.id) === key ? response.response : null;
      if (fresh) packet = rememberPacket(fresh);
    } catch (error) {
      // 网络失败时退回内存里已有的旧副本，让卡片至少能显示已缓存的字段。
      if (!packet) return { ok: false, error: error instanceof Error ? error.message : '读取红包详情失败' };
    }
  }
  return packet ? { ok: true, packet } : { ok: false, error: '暂时读不到红包详情，请到红包站核对' };
}

async function handleSubmit(message) {
  const claimMode = normalizeClaimMode(message?.claimMode);
  const incoming = Array.isArray(message?.codes) ? message.codes : [];
  const created = [];
  for (const item of incoming) {
    const code = typeof item?.code === 'string' ? item.code : '';
    const charset = item?.charset === 'numeric' ? 'numeric' : 'text';
    if (!code) continue;
    // 面板已经清洗过，这里再校验一次，避免别的调用方塞进非法口令。
    if (codes.validateCode(code, charset)) continue;
    created.push({
      id: createId(),
      code,
      charset,
      claimMode,
      packetId: null,
      matched: false,
      status: 'queued',
      result: '',
      lines: null,
      packet: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      scheduledAt: null,
    });
  }
  if (!created.length) return { ok: false, error: '没有可提交的有效口令' };
  state.entries = state.entries.concat(created);
  await commit();
  scheduleTick();
  return { ok: true, added: created.length, state: snapshot() };
}

/* ------------------------------ 图标点击去向 ------------------------------ */

// 「显示方式」是用户的持久选择（settings.display），它同时决定点扩展图标会发生什么：
//   - 停靠（'sidebar'）：图标点击交给浏览器开合侧边栏，popup 清空；
//   - 悬浮（'panel'）：图标点击弹出清单里的 popup。
// 这两件事只有后台改得了，面板那边看不见结果，所以后台在「设置变更后」与「worker 起来时」
// 各重放一次——浏览器会把它们记在扩展自己的偏好里（重载扩展又会回到清单默认值）。
let actionModeSynced = null;

async function syncActionMode() {
  const loaded = await getState();
  const docked = loaded.settings.display === 'sidebar';
  if (actionModeSynced === docked) return;
  actionModeSynced = docked;
  try {
    // 停靠时点图标＝开合侧边栏；悬浮时必须关掉它，否则图标点击会被它截走。
    await api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: docked });
  } catch (error) {
    console.warn('[红包口令面板] 侧边栏图标行为设置失败', error);
  }
  try {
    // 空字符串＝图标不带 popup（点击交给侧边栏）；悬浮时恢复清单里的那一页。
    await api.action?.setPopup?.({ popup: docked ? '' : 'popup.html' });
  } catch (error) {
    console.warn('[红包口令面板] 图标弹窗开关设置失败', error);
  }
}

// 消息契约（扩展页面 → 后台）。
// hb:ping         → { ok, version }
// hb:state:get    → { ok, state }
// hb:state:patch  → { ok, state }（settings 合并）
// hb:submit       → { ok, added, state }（载荷 { codes: [{ code, charset }], claimMode }）
// hb:claim        → { ok, state }（载荷 { id, trusted: true }，真实点击授权后的一次性领取）
//                   成功时附带 { outcome, packet }：面板详情卡片据此渲染领取金额与记录
// hb:packet       → { ok, packet }（载荷 { id, refresh, cache }，只读红包本身：cache 只问内存，
//                   refresh 再发一次只读 GET；按 id 只读不进限速，详情窗口靠它省掉能省的请求）
// hb:void / hb:delete / hb:clear / hb:void-all / hb:resume → { ok, state }
// hb:session      → { ok, loggedIn, username, linuxdo_id }
async function handleMessage(message) {
  await getState();
  switch (message?.type) {
    case 'hb:ping':
      return { ok: true, version: VERSION };
    case 'hb:state:get':
      return { ok: true, state: snapshot() };
    case 'hb:state:patch': {
      const patch = isPlainObject(message.patch) ? message.patch : {};
      if (isPlainObject(patch.settings)) {
        state.settings = normalizeSettings({ ...state.settings, ...patch.settings });
      }
      await commit();
      // 显示方式变了就同步图标点击的去向（没变的话 syncActionMode 自己会跳过）。
      await syncActionMode();
      return { ok: true, state: snapshot() };
    }
    case 'hb:submit':
      return handleSubmit(message);
    case 'hb:claim':
      return handleClaim(message);
    case 'hb:packet':
      return readPacket(message.id, {
        refresh: message.refresh === true,
        cacheOnly: message.cache === true,
      });
    case 'hb:void':
      return { ok: true, state: await voidEntry(String(message.id || '')) };
    case 'hb:delete':
      return { ok: true, state: await deleteEntry(String(message.id || '')) };
    case 'hb:void-all':
      return { ok: true, state: await voidAllQueued() };
    case 'hb:clear':
      return { ok: true, state: await clearHistory() };
    case 'hb:resume':
      return { ok: true, state: await resumeQueue() };
    case 'hb:session': {
      const response = await siteRequest(P.sessionUrl(), 'GET');
      const user = response.status === 200 ? response.response?.user : null;
      // linuxdo_id 用来判断「这是你发出的红包」与自己是否中奖，详情卡片需要它。
      return { ok: true, loggedIn: Boolean(user), username: user?.username || '', linuxdo_id: user?.linuxdo_id ?? null };
    }
    default:
      return { ok: false, error: '未知消息：' + String(message?.type) };
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true; // 异步响应，必须保持消息通道打开
});

api.runtime.onInstalled.addListener(() => {
  // 首次安装写入默认配置，面板据此渲染；重复安装不覆盖用户配置。
  return api.storage.local.get(STATE_KEY).then((bag) => {
    if (isPlainObject(bag?.[STATE_KEY])) return undefined;
    return api.storage.local.set({ [STATE_KEY]: emptyState() });
  }).then(async () => {
    // 重载扩展会把图标行为打回清单默认值，装完按存储里的选择补一次。
    await syncActionMode();
    return tick();
  });
});

api.runtime.onStartup?.addListener(() => {
  scheduleTick();
  syncActionMode().catch(() => {});
});

api.alarms?.onAlarm.addListener((alarm) => {
  if (alarm?.name === TICK_ALARM) scheduleTick();
});

// worker 每次被唤醒都可能是在队列中途：先载入状态，把该跑的接着跑。
scheduleTick();
// 图标点击的去向也随 worker 唤醒重放一次（设置变了、或浏览器把偏好忘了都会在这里补上）。
syncActionMode().catch(() => {});

