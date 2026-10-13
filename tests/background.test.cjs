/* 后台集成自检：在 vm 沙箱里加载 background.js，用假时钟与假网络驱动真实消息契约。
 *
 * 覆盖里程碑 2/3 的验收点：限速时间戳落在 storage（worker 回收后不提前发请求）、
 * 队列串行执行、失败暂停、领取的一次性授权、中断恢复、删除墓碑与状态合并。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const START = 1_700_000_000_000;
const STATE_KEY = 'hb-state-v1';
const HAPPY_CODE = '新年快乐发财';
const HAPPY_CODE_2 = '恭喜恭喜发财';

function entry(overrides) {
  return {
    id: 'e1',
    code: HAPPY_CODE,
    charset: 'text',
    claimMode: 'manual',
    packetId: null,
    matched: false,
    status: 'queued',
    result: '',
    lines: null,
    packet: null,
    createdAt: START,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const ACTIVE_PACKET = {
  id: 'p1',
  type: 'random',
  status: 'active',
  wish: '恭喜发财，大吉大利',
  code: HAPPY_CODE,
  creator: { username: 'alice', linuxdo_id: 1 },
  total_amount: 10,
  count: 5,
  claimed_amount: 2,
  mine: null,
};

const LOTTERY_CODE = '拼手气抽奖口令';
const LOTTERY_PACKET = {
  id: 'L1',
  type: 'lottery',
  status: 'active',
  wish: '拼手气抽奖',
  code: LOTTERY_CODE,
  creator: { username: 'alice', linuxdo_id: 1 },
  total_amount: 20,
  count: 3,
  claimed_amount: 0,
  mine: null,
  joined: false,
  drawn_at: null,
  draw_at: START + 60000,
  server_now: START,
};

// 抽奖口令的三段网络：口令查询、报名 /grab、看护按 id 读红包。
function lotteryHandler({ join, byId, query }) {
  return (url) => {
    if (url.endsWith('/api/me')) return sessionUser;
    if (url.endsWith('/L1/grab')) return join();
    if (url.endsWith('/api/hongbao/L1')) return byId();
    return query ? query() : { status: 200, body: LOTTERY_PACKET };
  };
}

// 沙箱：外壳只有 chrome API 与定时器替身，业务逻辑仍然是 src/background.js 本身。
async function createEnv({ stored = null, handler } = {}) {
  const clock = { now: START };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }

  const raw = new Map();
  if (stored) raw.set(STATE_KEY, JSON.parse(JSON.stringify(stored)));

  const timers = new Map();
  const listeners = { message: [], alarm: [] };
  const requests = [];
  const alarms = new Map();
  // 图标点击去向的两项设置：setPanelBehavior 决定点图标开合侧边栏，setPopup 决定要不要弹 popup。
  const panelBehavior = [];
  const popups = [];
  let timerSeq = 0;

  // 详情窗口的替身：够 card-window.js 用——开窗、认活着的窗口、拉到前面、收掉旧窗口，
  // 以及按卡片种类把窗口号登记进会话存储（真实浏览器里是窗口里的 card.js 自己登记）。
  const cardWindows = [];
  const windowUpdates = [];
  const windowRemovals = [];
  const sessionBag = {};
  let windowSeq = 0;

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.4.0' }),
      getURL: (assetPath) => 'chrome-extension://harness/' + assetPath,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (key) => (raw.has(key) ? { [key]: JSON.parse(JSON.stringify(raw.get(key))) } : {}),
        set: async (bag) => {
          for (const [key, value] of Object.entries(bag)) raw.set(key, JSON.parse(JSON.stringify(value)));
        },
      },
      session: {
        get: async (key) => (key in sessionBag ? { [key]: sessionBag[key] } : {}),
        set: async (items) => { Object.assign(sessionBag, items); },
        remove: async (key) => { delete sessionBag[key]; },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, info); },
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    windows: {
      // 窗口被关掉、或换成别的红包后被收掉：windows.get 就认不到了（等同被关掉）。
      get: async (id) => {
        const found = cardWindows.find((item) => item.id === id);
        if (!found) throw new Error('窗口已关闭');
        return { id };
      },
      create: async (props) => {
        windowSeq += 1;
        const id = windowSeq;
        cardWindows.push({ id, ...props });
        const url = new URL(props.url);
        const view = url.searchParams.get('view') === 'detail' ? 'detail' : 'claim';
        const bag = sessionBag['hb-card-window'] && typeof sessionBag['hb-card-window'] === 'object'
          ? sessionBag['hb-card-window'] : {};
        bag[view] = { windowId: id, entryId: url.searchParams.get('id') };
        sessionBag['hb-card-window'] = bag;
        return { id };
      },
      update: async (id, props) => { windowUpdates.push({ id, ...props }); return { id }; },
      remove: async (id) => {
        windowRemovals.push(id);
        const index = cardWindows.findIndex((item) => item.id === id);
        if (index >= 0) cardWindows.splice(index, 1);
      },
    },
    sidePanel: {
      setPanelBehavior: async (behavior) => { panelBehavior.push(JSON.parse(JSON.stringify(behavior))); },
    },
    action: {
      setPopup: async (options) => { popups.push(JSON.parse(JSON.stringify(options))); },
    },
  };

  const sandbox = {
    console,
    chrome,
    crypto: { randomUUID: (() => { let seq = 0; return () => 'id-' + (++seq); })() },
    Date: FakeDate,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { at: clock.now + (Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const reply = handler(url, options, requests.length);
      requests.push({ url, method: options.method || 'GET', at: clock.now });
      // reply.wait（毫秒，走假时钟）模拟慢响应：只有把刻度记在响应结束才会有意义。
      if (reply.wait) await new Promise((resolve) => sandbox.setTimeout(resolve, reply.wait));
      return { status: reply.status, json: async () => (reply.body === undefined ? null : reply.body) };
    },
    AbortController,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      const file = path.join(ROOT, name);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
  };

  const flush = async (rounds = 5) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  // 把时钟推到指定位置，按顺序执行到期的定时器（幂等：已执行的定时器会从表里删除）。
  const advance = async (ms) => {
    const target = clock.now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].fn();
      await flush();
    }
    clock.now = target;
    await flush();
  };

  const env = {
    clock,
    requests,
    alarms,
    panelBehavior,
    popups,
    cardWindows,
    windowUpdates,
    windowRemovals,
    sessionBag,
    listeners,
    // 面板/后台开窗都走这份 HBCardWindow（沙箱里的 globalThis）；自检里直接调它模拟「点历史行」。
    cardWindow: () => sandbox.globalThis.HBCardWindow,
    async send(message) {
      return new Promise((resolve) => {
        let answered = false;
        const sendResponse = (value) => { answered = true; resolve(value); };
        const returned = listeners.message[0](message, {}, sendResponse);
        if (returned !== true && !answered) resolve(undefined);
      });
    },
    flush,
    advance,
    stored: async () => (raw.has(STATE_KEY) ? JSON.parse(JSON.stringify(raw.get(STATE_KEY))) : null),
    fireAlarm: async (name) => {
      for (const listener of listeners.alarm) listener({ name });
      await flush();
    },
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  // 模块顶部的 tick() 在这里落定：新 worker 唤醒后会接着跑队列。
  await flush();
  return env;
}

const okQuery = (body) => () => ({ status: 200, body });
const sessionUser = { status: 200, body: { user: { username: 'bob', linuxdo_id: 2 } } };
// 沙箱里的数组属于另一个 realm，比较前先转成本 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

test('两次查询至少间隔 5 秒，限速时间戳写入 storage', async () => {
  const env = await createEnv({ handler: okQuery({ error: '口令不存在' }) });
  const submit = await env.send({
    type: 'hb:submit',
    codes: [{ code: HAPPY_CODE, charset: 'text' }, { code: HAPPY_CODE_2, charset: 'text' }],
    claimMode: 'manual',
  });
  assert.equal(submit.ok, true);
  assert.equal(submit.added, 2);
  await env.flush();

  assert.equal(env.requests.length, 1, '第一条应立即发出');
  await env.advance(4999);
  assert.equal(env.requests.length, 1, '间隔未到不得发出第二条');
  await env.advance(1);
  assert.equal(env.requests.length, 2, '间隔到点后发出第二条');
  assert.ok(env.requests[1].at - env.requests[0].at >= 5000, String(env.requests[1].at - env.requests[0].at));

  const stored = await env.stored();
  // 刻度记的是上一次请求「结束」的时刻（假响应瞬时返回，结束时刻即发出时刻）。
  assert.equal(stored.lastFinishedAt, env.requests[1].at);

  const state = await env.send({ type: 'hb:state:get' });
  assert.deepEqual(plain(state.state.entries.map((item) => item.status)), ['done', 'done']);
  assert.equal(state.state.entries[0].result, '未匹配: 口令不存在');
});

test('间隔从「上一次结束」起算：响应慢也不会按开始时刻提前发出', async () => {
  // 第一条查询 3 秒才返回，第二条要等到「第一条结束 + 5 秒」，也就是开始后 8 秒。
  let call = 0;
  const env = await createEnv({
    handler: () => {
      call += 1;
      return call === 1 ? { status: 200, body: { error: '口令不存在' }, wait: 3000 } : { status: 200, body: { error: '口令不存在' } };
    },
  });
  await env.send({
    type: 'hb:submit',
    codes: [{ code: HAPPY_CODE, charset: 'text' }, { code: HAPPY_CODE_2, charset: 'text' }],
    claimMode: 'manual',
  });
  await env.flush();
  assert.equal(env.requests.length, 1, '第一条立即发出');

  await env.advance(3000);
  assert.equal(env.requests.length, 1, '第一条的响应刚到，刻度从这一刻才重新起算');
  await env.advance(4999);
  assert.equal(env.requests.length, 1, '按开始时刻算会在第 5 秒发出，按结束时刻算还差 1 毫秒');
  await env.advance(1);
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].at - env.requests[0].at, 8000, '响应耗时也算进间隔');
});

test('加时设置进入查询间隔', async () => {
  const env = await createEnv({
    stored: { entries: [], removed: [], settings: { gapExtraMs: 2000 }, paused: false, pausedReason: '', lastStartedAt: 0 },
    handler: okQuery({ error: '口令不存在' }),
  });
  await env.send({
    type: 'hb:submit',
    codes: [{ code: HAPPY_CODE, charset: 'text' }, { code: HAPPY_CODE_2, charset: 'text' }],
    claimMode: 'manual',
  });
  await env.flush();
  await env.advance(6999);
  assert.equal(env.requests.length, 1, '5 秒基础间隔加 2 秒加时，6999ms 还不该发');
  await env.advance(1);
  assert.equal(env.requests.length, 2);
  assert.ok(env.requests[1].at - env.requests[0].at >= 7000);
});

test('410 记为未匹配，不算失败也不暂停队列', async () => {
  const env = await createEnv({ handler: () => ({ status: 410, body: null }) });
  await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'done');
  assert.equal(state.state.entries[0].result, '未匹配: 红包已过期');
  assert.equal(state.state.paused, false);
});

test('查询失败会暂停队列，继续后才跑下一条', async () => {
  const env = await createEnv({ handler: () => ({ status: 500, body: null }) });
  await env.send({
    type: 'hb:submit',
    codes: [{ code: HAPPY_CODE, charset: 'text' }, { code: HAPPY_CODE_2, charset: 'text' }],
    claimMode: 'manual',
  });
  await env.flush();

  let state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'failed');
  assert.match(state.state.entries[0].result, /^查询失败: HTTP 500/);
  assert.equal(state.state.paused, true);
  assert.match(state.state.pausedReason, /^查询失败: HTTP 500/);
  assert.equal(state.state.entries[1].status, 'queued');

  await env.advance(60000);
  assert.equal(env.requests.length, 1, '暂停期间不得再发请求');

  const resumed = await env.send({ type: 'hb:resume' });
  assert.equal(resumed.state.paused, false);
  await env.advance(5000);
  assert.equal(env.requests.length, 2, '继续后跑下一条');
  state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[1].status, 'failed');
});

test('古法：匹配后停在待开启，点击授权才领取一次', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return { status: 200, body: { user: { username: 'bob', linuxdo_id: 2 } } };
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 1.23 } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();

  const awaiting = submit.state.entries[0];
  assert.equal(awaiting.status, 'awaiting');
  assert.equal(awaiting.packetId, 'p1');
  assert.equal(awaiting.packet.creator.username, 'alice');
  assert.equal(awaiting.packet.claimMode, undefined, '快照只保留白名单字段');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '古法不自动领取');

  const id = (await env.send({ type: 'hb:state:get' })).state.entries[0].id;

  // 古法匹配后就该自动弹出领取卡片（脚本版 showClaimEnvelope / showLotteryEnvelope 的对应物）：
  // 开出来的只有领取卡片那种（view=claim），点历史行进的是另一种只读卡片。
  assert.equal(env.cardWindows.length, 1, '匹配后自动弹出一张领取卡片');
  assert.match(env.cardWindows[0].url, /card\.html\?id=.*&view=claim$/, env.cardWindows[0].url);
  assert.equal(env.cardWindows[0].type, 'popup');
  assert.deepEqual(env.sessionBag['hb-card-window'].claim,
    { windowId: env.cardWindows[0].id, entryId: id }, '领取卡片按 kind 登记会话记录');

  const denied = await env.send({ type: 'hb:claim', id, trusted: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, '缺少有效的领取授权，未发送领取请求');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '没有真实点击授权就不发 POST');

  // 领取的那次 POST 不进口令查询的间隔（v0.12.1）：查询刚返回就点也当场发出去，既不额外
  // 等 5 秒，也不把刻度顶到「刚刚」把后面的口令挤成排队。
  const clockBeforeClaim = (await env.stored()).lastFinishedAt;
  const clickedAt = env.clock.now;
  const claimed = await env.send({ type: 'hb:claim', id, trusted: true });
  assert.equal(claimed.ok, true);
  const posted = env.requests.filter((item) => item.method === 'POST');
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/hongbao\/p1\/grab$/);
  assert.equal(posted[0].at, clickedAt, '点击即发，不等口令查询的间隔');
  assert.equal((await env.stored()).lastFinishedAt, clockBeforeClaim, '领取不刷新口令查询的刻度');

  const entryAfter = claimed.state.entries[0];
  assert.equal(entryAfter.status, 'done');
  assert.equal(entryAfter.result, '领取成功: +1.23 LDC');
  assert.equal(entryAfter.lines[0].text, '恭喜发财，大吉大利');

  const again = await env.send({ type: 'hb:claim', id, trusted: true });
  assert.equal(again.ok, false);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '一次点击只放行一次请求');
});

// 刻度只写「口令查询结束」那一刻（脚本版 sharedQuery 的 finally 与这里同义）。操作里跟在
// 查询后面的协议领取 POST 再慢，也不把下一次查询往后推（v0.12.2）。
test('协议领取：领取 POST 慢 3 秒，刻度仍停在口令查询结束那一刻', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 2.5 }, wait: 3000 };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'direct' });
  await env.flush();

  const query = env.requests.find((item) => item.url.includes('/text-code/'));
  assert.ok(query, '先发一次口令查询');
  const posted = env.requests.filter((item) => item.method === 'POST');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].at, query.at, '协议领取紧跟在查询后面发出，不额外等一个间隔');
  assert.equal((await env.stored()).lastFinishedAt, query.at, '刻度在查询结束时就已经写下');

  await env.advance(3000);
  const stored = await env.stored();
  assert.equal(stored.entries[0].status, 'done');
  assert.equal(stored.entries[0].result, '领取成功: +2.50 LDC');
  assert.equal(stored.lastFinishedAt, query.at, '领取 POST 的耗时不算进间隔');
});

test('古法：历史点击开只读详情卡片，与自动弹出的领取卡片各占一个窗口', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 1.23 } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const entry = submit.state.entries[0];
  assert.equal(entry.status, 'awaiting');

  const claimWindow = env.cardWindows[0];
  assert.ok(claimWindow, '匹配后应自动弹出领取卡片');
  assert.ok(claimWindow.url.endsWith('view=claim'), claimWindow.url);

  // 点历史行的红包按钮＝只读详情卡片（view=detail），与领取卡片并存、互不顶掉（脚本版里
  // 历史卡与领取卡也是两张）。
  const opened = await env.cardWindow().open({ id: entry.id, entry, packet: entry.packet, view: 'detail' });
  assert.equal(opened.ok, true);
  assert.equal(opened.action, 'created');
  const detailWindow = env.cardWindows.find((item) => item.id === opened.windowId);
  assert.ok(detailWindow && detailWindow.url.endsWith('view=detail'), detailWindow && detailWindow.url);
  assert.equal(env.cardWindows.length, 2, '领取卡片与详情卡片各占一个窗口');

  // 同一个红包再点一次历史行：把详情卡片拉到前面，不再多开。
  const repeated = await env.cardWindow().open({ id: entry.id, entry, packet: entry.packet, view: 'detail' });
  assert.equal(repeated.action, 'focused');
  assert.equal(repeated.windowId, opened.windowId);
  assert.equal(env.cardWindows.length, 2, '同一个红包的详情卡片只开一个');
  assert.ok(env.windowUpdates.some((item) => item.id === repeated.windowId && item.focused === true));

  // 领取之后领取卡片只剩结论，与详情卡片是同一件事：这时点历史行直接聚焦它，不再多开。
  const approving = env.send({ type: 'hb:claim', id: entry.id, trusted: true });
  await env.advance(5000);
  const claimed = await approving;
  assert.equal(claimed.ok, true);
  const settled = claimed.state.entries[0];
  assert.equal(settled.status, 'done');
  const before = env.cardWindows.length;
  const focused = await env.cardWindow().open({ id: settled.id, entry: settled, packet: settled.packet, view: 'detail' });
  assert.equal(focused.action, 'focused');
  assert.equal(focused.windowId, claimWindow.id, '领取落定后点历史行聚焦那张领取卡片');
  assert.equal(env.cardWindows.length, before, '领取落定后点历史行不多开窗口');
});

test('关掉领取卡片＝这一次没有领：条目写成未领取，之后不再接受领取', async () => {
  const handler = (url) => {
    if (url.endsWith('/api/me')) return sessionUser;
    if (url.endsWith('/grab')) return { status: 200, body: { amount: 1.23 } };
    return { status: 200, body: ACTIVE_PACKET };
  };
  const env = await createEnv({ handler });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const entry = submit.state.entries[0];
  assert.equal(entry.status, 'awaiting');

  // 卡片窗口在 pagehide 时报这一条（渲染进程被直接杀掉时由 windows.onRemoved 兜底，同一道判据）。
  const closed = await env.send({ type: 'hb:card-closed', id: entry.id });
  assert.equal(closed.ok, true);
  const settled = closed.state.entries[0];
  assert.equal(settled.status, 'done', '关掉领取卡片后条目不再等领取');
  assert.equal(settled.result, '未领取: 已关闭红包');
  assert.equal(settled.packetId, 'p1', '关掉卡片不动红包快照，历史行照旧能看详情');

  // 落定之后再点一次也发不出去：状态已经不是 awaiting。
  const refused = await env.send({ type: 'hb:claim', id: entry.id, trusted: true });
  assert.equal(refused.ok, false);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '关掉卡片后不该再发领取请求');

  // 页面与兜底各报一次（重复到达）也不改写：已经不是 awaiting，原样返回。
  const repeat = await env.send({ type: 'hb:card-closed', id: entry.id });
  assert.equal(repeat.state.entries[0].result, '未领取: 已关闭红包');

  // 已经领到的条目不会被这条消息改写（晚到、重到都不行）。
  const env2 = await createEnv({ handler });
  const submit2 = await env2.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env2.flush();
  const id2 = submit2.state.entries[0].id;
  assert.equal((await env2.send({ type: 'hb:claim', id: id2, trusted: true })).ok, true);
  await env2.send({ type: 'hb:card-closed', id: id2 });
  assert.equal((await env2.stored()).entries[0].result, '领取成功: +1.23 LDC', '已经领到的条目不被「关闭」改写');
});

test('协议：匹配后由后台直接领取', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 2.5 } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'direct' });
  await env.flush();
  const stored = await env.stored();
  assert.equal(stored.entries[0].status, 'done');
  assert.equal(stored.entries[0].result, '领取成功: +2.50 LDC');
  assert.equal(submit.state.entries[0].claimMode, 'direct');
});

// 动态模式：口令查到红包之后才谈得上判定——总额／人均都是站点回包里的字段。
test('动态：人均达到阈值就走协议（等于阈值也算达标）', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 2.5 } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  // ACTIVE_PACKET 是总额 10、5 份：人均 2.00，阈值正好 2.00。
  await env.send({
    type: 'hb:state:patch',
    patch: { settings: { claimMode: 'dynamic', claimMetric: 'average', claimThreshold: 2 } },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'dynamic' });
  await env.flush();

  const entry = plain(submit.state.entries[0]);
  const texts = entry.lines.map((item) => item.text);
  assert.equal(entry.status, 'done');
  assert.equal(entry.claimMode, 'direct', '判定结果落回条目，不再是 dynamic');
  assert.ok(texts.includes('动态：人均 2.00 LDC ≥ 阈值 2.00，自动协议领取'), JSON.stringify(texts));
  assert.equal(texts[texts.length - 1], '领取成功: +2.50 LDC', '判定行在前，领取结果在后');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '达标才发这一次写请求');
});

test('动态：达不到阈值转古法，弹卡片等真实点击', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 1.23 } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  // 按总额判：10.00 < 30.00，转古法。
  await env.send({
    type: 'hb:state:patch',
    patch: { settings: { claimMode: 'dynamic', claimMetric: 'total', claimThreshold: 30 } },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'dynamic' });
  await env.flush();

  const entry = plain(submit.state.entries[0]);
  assert.equal(entry.status, 'awaiting');
  assert.equal(entry.claimMode, 'manual', '转古法后条目就是 manual，领取卡片与 hb:claim 才认它');
  assert.equal(entry.result, '等待手动开启');
  assert.ok(entry.lines.map((item) => item.text).includes('动态：总额 10.00 LDC < 阈值 30.00，转古法手动开启'));
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '不达标不发写请求');
  assert.equal(env.cardWindows.length, 1, '转古法照旧自动弹领取卡片');
  assert.match(env.cardWindows[0].url, /view=claim$/);

  // 走的是古法那条路：卡片上的真实点击仍然能领取。
  const approving = env.send({ type: 'hb:claim', id: entry.id, trusted: true });
  await env.flush();
  await env.advance(5000);
  const claimed = await approving;
  assert.equal(claimed.ok, true);
  assert.equal(plain(claimed.state.entries[0]).status, 'done', '点击后照旧领取成功');
});

test('动态：算不出人均（红包没有份数）时转古法，阈值 0 也不自动领取', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      return { status: 200, body: { ...ACTIVE_PACKET, count: null } };
    },
  });
  await env.send({
    type: 'hb:state:patch',
    patch: { settings: { claimMode: 'dynamic', claimMetric: 'average', claimThreshold: 0 } },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'dynamic' });
  await env.flush();

  const entry = plain(submit.state.entries[0]);
  assert.equal(entry.status, 'awaiting');
  assert.equal(entry.claimMode, 'manual');
  assert.ok(entry.lines.map((item) => item.text).includes('动态：人均 未知 < 阈值 0.00，转古法手动开启'));
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '判定量取不到就不发写请求');
});

test('唤醒时动态条目保持 dynamic，等口令查回来才判定', async () => {
  const stored = {
    entries: [entry({ id: 'dyn-1', status: 'queued', claimMode: 'dynamic' })],
    removed: [],
    settings: { claimMode: 'dynamic', claimMetric: 'average', claimThreshold: 3 },
    paused: false,
    pausedReason: '',
    lastFinishedAt: 0,
  };
  const env = await createEnv({
    stored,
    handler: (url) => (url.endsWith('/api/me') ? sessionUser : { status: 200, body: ACTIVE_PACKET }),
  });
  await env.flush();

  const row = plain((await env.send({ type: 'hb:state:get' })).state.entries[0]);
  assert.equal(row.status, 'awaiting');
  assert.equal(row.claimMode, 'manual', '唤醒后接着跑，查到人均 2.00 < 3，落成古法');
  assert.ok(row.lines.map((item) => item.text).includes('动态：人均 2.00 LDC < 阈值 3.00，转古法手动开启'));
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0);
});

test('领取结果无法确认时提示核对且不自动重试', async () => {
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: {} };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'direct' });
  await env.flush();
  assert.equal(submit.state.entries[0].status, 'failed');
  assert.match(submit.state.entries[0].result, /领取结果未确认/);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '未确认也不重试');
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.paused, true);
});

test('worker 被回收后，running 条目记为中断且不自动重试', async () => {
  const env = await createEnv({
    stored: {
      entries: [entry({ id: 'mid', status: 'running', startedAt: START - 1000, claimMode: 'direct', packetId: 'p9' })],
      removed: [],
      settings: {},
      lastStartedAt: START - 1000,
    },
    handler: () => ({ status: 200, body: ACTIVE_PACKET }),
  });
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'failed');
  assert.match(state.state.entries[0].result, /结果未确认/);
  assert.equal(env.requests.length, 0, '被打断的条目不会自动重发');
});

test('worker 回收后，限速时间戳仍挡住提前请求（并迁移旧字段）', async () => {
  const env = await createEnv({
    stored: {
      entries: [entry({ id: 'wait', status: 'queued' })],
      removed: [],
      settings: {},
      // 旧版本记的是「上一次开始」：迁移后一律当结束时刻用，只会多等，不会提前。
      lastStartedAt: START - 1000,
    },
    handler: okQuery({ error: '口令不存在' }),
  });
  await env.flush();
  assert.equal(env.requests.length, 0, '唤醒时距离上次请求还不到 5 秒');
  await env.advance(3999);
  assert.equal(env.requests.length, 0);
  await env.advance(1);
  assert.equal(env.requests.length, 1);
  assert.ok(env.requests[0].at - (START - 1000) >= 5000);
  const stored = await env.stored();
  assert.equal(stored.lastFinishedAt, env.requests[0].at, '刻度按新字段写回');
});

test('唤醒时上一条请求被打断：下一次请求再等满一个间隔', async () => {
  const env = await createEnv({
    stored: {
      entries: [
        entry({ id: 'mid', status: 'running', startedAt: START - 1000, claimMode: 'direct', packetId: 'p9' }),
        entry({ id: 'wait', code: HAPPY_CODE_2, status: 'queued', createdAt: START + 1 }),
      ],
      removed: [],
      settings: {},
      lastFinishedAt: START - 10000,
    },
    handler: okQuery({ error: '口令不存在' }),
  });
  await env.flush();
  assert.equal(env.requests.length, 0, '被打断的请求结束时刻无从得知，先等满一个间隔');
  await env.advance(4999);
  assert.equal(env.requests.length, 0);
  await env.advance(1);
  assert.equal(env.requests.length, 1, '等满间隔后才接着跑队列');
});

test('删除按 ID 墓碑，另一个实例读回也不会复活', async () => {
  const stored = {
    entries: [
      entry({ id: 'keep', status: 'done', result: '未匹配: 口令不存在', createdAt: START - 10 }),
      entry({ id: 'drop', code: HAPPY_CODE_2, status: 'done', result: '已作废', createdAt: START }),
    ],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastStartedAt: 0,
  };
  const env = await createEnv({ stored, handler: okQuery({ error: '口令不存在' }) });
  const removed = await env.send({ type: 'hb:delete', id: 'drop' });
  assert.deepEqual(plain(removed.state.entries.map((item) => item.id)), ['keep']);
  assert.deepEqual(plain(removed.state.removed.map((item) => item.id)), ['drop']);
  const afterDelete = await env.stored();
  assert.deepEqual(afterDelete.entries.map((item) => item.id), ['keep']);

  // 别处还留着旧副本时，墓碑保证它不会被写回来。
  const stale = { ...afterDelete, entries: [entry({ id: 'drop', code: HAPPY_CODE_2, status: 'done' }), ...afterDelete.entries] };
  const second = await createEnv({ stored: stale, handler: okQuery({ error: '口令不存在' }) });
  const state = await second.send({ type: 'hb:state:get' });
  assert.deepEqual(plain(state.state.entries.map((item) => item.id)), ['keep']);
});

test('清空历史留下在途条目并给其余条目打墓碑', async () => {
  const env = await createEnv({
    stored: {
      entries: [
        entry({ id: 'inflight', status: 'running', claimMode: 'direct', packetId: 'p1' }),
        entry({ id: 'settled', status: 'done', result: '已领取', createdAt: START + 1 }),
      ],
      removed: [],
      settings: {},
      lastStartedAt: START,
    },
    handler: () => ({ status: 200, body: ACTIVE_PACKET }),
  });
  const cleared = await env.send({ type: 'hb:clear' });
  const stored = await env.stored();
  // running 行在加载时已按中断处理（没有别的实例在跑），清空后只留墓碑。
  assert.deepEqual(stored.entries.map((item) => item.id), []);
  assert.deepEqual(stored.removed.map((item) => item.id).sort(), ['inflight', 'settled']);
  assert.equal(cleared.ok, true);
});

test('提交非法口令被后台挡下', async () => {
  const env = await createEnv({ handler: okQuery({ error: '口令不存在' }) });
  const response = await env.send({ type: 'hb:submit', codes: [{ code: 'abc', charset: 'text' }], claimMode: 'manual' });
  assert.equal(response.ok, false);
  assert.equal(response.error, '没有可提交的有效口令');
  assert.equal(env.requests.length, 0);
});

test('详情卡片：领取回执带回结果与红包，详情按 id 只读读取', async () => {
  const detail = {
    ...ACTIVE_PACKET,
    claimed_count: 2,
    claims: [{ share_id: 7, username: 'carol', amount: 1.23, at: 2 }],
  };
  const env = await createEnv({
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/grab')) return { status: 200, body: { amount: 1.23 } };
      if (url.endsWith('/api/hongbao/p1')) return { status: 200, body: detail };
      if (url.endsWith('/api/hongbao/nope')) return { status: 404, body: { error: '红包不存在' } };
      return { status: 200, body: ACTIVE_PACKET };
    },
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const id = submit.state.entries[0].id;

  // 领取回执与当时那份红包一起回给面板，面板据此渲染金额与进度。
  const approving = env.send({ type: 'hb:claim', id, trusted: true });
  await env.advance(5000);
  const claimed = await approving;
  assert.equal(claimed.ok, true);
  assert.equal(claimed.outcome.amount, 1.23);
  assert.equal(claimed.packet.id, 'p1');
  assert.equal(claimed.state.entries[0].result, '领取成功: +1.23 LDC');

  // 内存里已经有这份红包：只读读取直接命中，不再发请求。
  const cached = await env.send({ type: 'hb:packet', id: 'p1' });
  assert.equal(cached.ok, true);
  assert.equal(cached.packet.id, 'p1');
  assert.equal(env.requests.filter((item) => item.url.endsWith('/api/hongbao/p1')).length, 0,
    '内存里有红包快照时不发请求');

  // 详情窗口先问 cache：内存里这一份直接回给窗口铺卡片，一次请求都不发。
  const cacheOnly = await env.send({ type: 'hb:packet', id: 'p1', cache: true });
  assert.equal(cacheOnly.ok, true);
  assert.equal(cacheOnly.packet.id, 'p1');
  // 内存里没有时 cache 也不发请求，直接回失败：窗口据此挂一层 loading，再走一次 refresh。
  const cacheMiss = await env.send({ type: 'hb:packet', id: 'nope', cache: true });
  assert.equal(cacheMiss.ok, false);
  assert.match(cacheMiss.error, /内存里没有/);
  assert.equal(env.requests.filter((item) => item.url.endsWith('/api/hongbao/nope')).length, 0,
    'cache 读不发任何请求');

  // refresh 走一次只读 GET，把领取记录补回来，而且不会发写请求。按 id 只读不进限速：领取刚
  // 结束（刻度正热）它也立刻发，不用再等一个间隔。
  const hotClock = env.clock.now;
  const fresh = await env.send({ type: 'hb:packet', id: 'p1', refresh: true });
  assert.equal(fresh.ok, true);
  assert.deepEqual(plain(fresh.packet.claims.map((claim) => claim.username)), ['carol']);
  const detailReads = env.requests.filter((item) => item.url.endsWith('/api/hongbao/p1'));
  assert.equal(detailReads.length, 1);
  assert.equal(detailReads[0].at, hotClock, '详情读取不该等口令查询的间隔');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '详情读取不发写请求');

  // 读不到（也没有缓存）时给一条可读的错误，面板照旧显示本地记录。
  const missing = await env.send({ type: 'hb:packet', id: 'nope', refresh: true });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /读不到红包详情/);

  // 登录态带上 linuxdo_id：详情卡片用它判断「自己发的」与是否中奖。
  const session = await env.send({ type: 'hb:session' });
  assert.equal(session.loggedIn, true);
  assert.equal(session.linuxdo_id, 2);
});

test('队列跑完后清掉兜底闹钟', async () => {
  const env = await createEnv({ handler: okQuery({ error: '口令不存在' }) });
  await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  await env.advance(1000);
  assert.equal(env.alarms.has('hb-queue-tick'), false, '没有排队条目时不该留下闹钟');
});

test('古法抽奖：等手动参与，点击只报名一次，开奖后落到历史', async () => {
  const drawn = {
    ...LOTTERY_PACKET,
    joined: true,
    status: 'drawn',
    drawn_at: START + 61000,
    mine: 5,
    winners: [{ linuxdo_id: 2, amount: 5, payout_status: 'paid' }],
  };
  // 看护按 3 秒节奏裸轮询（脚本版 watchLotteryDraw 同节奏）：开奖前 byId 先读回「已报名、
  // 还没开奖」那一份，什么时候读到开奖结果由 drawnNow 决定，断言就不受轮询时机影响。
  let drawnNow = false;
  const env = await createEnv({
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: false, packet: { ...LOTTERY_PACKET, joined: true } } }),
      byId: () => ({ status: 200, body: drawnNow ? drawn : { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: LOTTERY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();

  const awaiting = submit.state.entries[0];
  assert.equal(awaiting.status, 'awaiting');
  assert.equal(awaiting.packet.type, 'lottery');
  assert.equal(awaiting.result, '等待手动参与抽选');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '古法不自动报名抽奖');
  // 古法抽奖也自动弹出领取卡片（卡片里是「参与抽选」按钮，脚本版 showLotteryEnvelope）。
  assert.equal(env.cardWindows.length, 1, '抽奖匹配后也自动弹出领取卡片');
  assert.match(env.cardWindows[0].url, /view=claim$/, env.cardWindows[0].url);

  const joining = env.send({ type: 'hb:claim', id: awaiting.id, trusted: true });
  await env.advance(5000);
  const joined = await joining;
  assert.equal(joined.ok, true);
  const posted = env.requests.filter((item) => item.method === 'POST');
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/hongbao\/L1\/grab$/);
  // 报名不是领取：行停在等待开奖，而不是“结果未确认”。
  assert.equal(joined.state.entries[0].status, 'awaiting');
  assert.equal(joined.state.entries[0].result, '已参与抽选，等待开奖');
  assert.equal(joined.state.entries[0].packet.joined, true);

  // 看护按 id 读红包，开奖后把中奖结果写回同一行。
  drawnNow = true;
  await env.advance(4000);
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'done');
  assert.equal(state.state.entries[0].result, '已中奖: +5.00 LDC（已到账）');
  assert.equal(state.state.paused, false);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '看护不发写请求');

  // 看护读回的开奖结果留在内存快照里：面板打开详情卡片时不用再发请求。
  const before = env.requests.length;
  const detail = await env.send({ type: 'hb:packet', id: 'L1' });
  assert.equal(detail.ok, true);
  assert.deepEqual(plain(detail.packet.winners.map((item) => item.amount)), [5]);
  assert.equal(env.requests.length, before, '内存里已有开奖结果，不再发请求');
});

test('协议抽奖：后台自动报名并等开奖，不误报未确认', async () => {
  const env = await createEnv({
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: true, packet: { ...LOTTERY_PACKET, joined: true } } }),
      byId: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  await env.send({ type: 'hb:submit', codes: [{ code: LOTTERY_CODE, charset: 'text' }], claimMode: 'direct' });
  await env.flush();

  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].claimMode, 'direct');
  assert.equal(state.state.entries[0].status, 'awaiting');
  assert.equal(state.state.entries[0].result, '已参与过抽选，等待开奖');
  assert.equal(state.state.paused, false, '抽奖报名不该暂停队列');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(env.alarms.has('hb-queue-tick'), true, '等开奖期间保留兜底闹钟');
});

test('开奖迟迟不来就收摊：写下未确认文案，队列继续可用', async () => {
  const env = await createEnv({
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: false, packet: { ...LOTTERY_PACKET, joined: true } } }),
      byId: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: LOTTERY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const joining = env.send({ type: 'hb:claim', id: submit.state.entries[0].id, trusted: true });
  await env.advance(5000);
  await joining;
  await env.flush();

  // 收摊时刻是 draw_at 之后 120 秒，也就是现在起 180 秒。
  await env.advance(200000);
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'done');
  assert.equal(state.state.entries[0].result, '开奖结果未确认，请到红包站查看记录');
  assert.equal(state.state.paused, false);
  assert.ok(env.requests.filter((item) => item.url.endsWith('/api/hongbao/L1')).length > 1, '看护按 3 秒节奏重试');
  assert.equal(env.alarms.has('hb-queue-tick'), false, '收摊后清掉兜底闹钟');
});

test('唤醒不重查待开启的抽奖：看护按落库的收摊时刻装回来，不重复报名', async () => {
  const stored = {
    entries: [entry({
      claimMode: 'manual',
      status: 'awaiting',
      packetId: 'L1',
      matched: true,
      // v0.11.1 起看护的收摊时刻跟着条目落库：唤醒后不必再查一遍口令就知道该盯到什么时候。
      watchUntil: START + 60_000 + 120_000,
      lines: [{ text: '已参与抽选，等待开奖', tone: 'success' }],
      result: '已参与抽选，等待开奖',
      packet: { id: 'L1', type: 'lottery', status: 'active', joined: true, creator: { username: 'alice', linuxdo_id: 1 }, draw_at: START + 60000, server_now: START },
    })],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastFinishedAt: START - 600_000,
  };
  // 看护装上就按 id 裸轮询（脚本版 watchLotteryDraw 同样一装上就读一次），
  // 什么时候读到开奖结果由 drawnNow 决定。
  let drawnNow = false;
  const env = await createEnv({
    stored,
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: true, packet: null } }),
      byId: () => ({
        status: 200,
        body: drawnNow
          ? { ...LOTTERY_PACKET, joined: true, status: 'drawn', drawn_at: START + 61000, count: 3, winners: [] }
          : { ...LOTTERY_PACKET, joined: true },
      }),
      query: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  await env.flush();
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'awaiting');
  assert.equal(state.state.entries[0].result, '已参与抽选，等待开奖', '待开启的行不再被重查，写入结果原样留着');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '已报名的口令不得再次报名');
  assert.equal(env.requests.filter((item) => item.url.includes('text-code')).length, 0,
    '唤醒不该再发一次口令查询（它会顶掉限速刻度）');
  assert.equal((await env.stored()).lastFinishedAt, START - 600_000, '唤醒不该碰限速刻度');
  assert.ok(env.requests.filter((item) => item.url.endsWith('/api/hongbao/L1')).length >= 1, '看护没有装回来');

  // 看护读到开奖结果就把结果写回同一行（这条口令不再报名一次）。
  drawnNow = true;
  await env.advance(4000);
  const after = await env.send({ type: 'hb:state:get' });
  assert.equal(after.state.entries[0].status, 'done');
  assert.equal(after.state.entries[0].result, '未抽中');
  assert.equal(after.state.entries[0].watchUntil, null, '落定后不再留收摊时刻');
});

test('老记录没有收摊时刻：唤醒时自愈一次，重查口令后把它补齐', async () => {
  // v0.11.0 及以前写下的待开启抽奖没有 watchUntil。这样的老记录仍按老路走一次（回队列重查
  // 口令），查到 joined 就把收摊时刻落库，往后每次唤醒都不再重查。
  const stored = {
    entries: [entry({
      id: 'legacy-1',
      code: LOTTERY_CODE,
      claimMode: 'manual',
      status: 'awaiting',
      packetId: 'L1',
      matched: true,
      packet: { id: 'L1', type: 'lottery', status: 'active', joined: true, creator: { username: 'alice', linuxdo_id: 1 }, draw_at: START + 60_000, server_now: START },
    })],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastFinishedAt: START - 600_000,
  };
  const env = await createEnv({
    stored,
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: true, packet: null } }),
      byId: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
      query: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  await env.flush();

  assert.equal(env.requests.filter((item) => item.url.includes('text-code')).length, 1, '老记录该重查一次口令');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '重查不等于重新报名');
  const healed = (await env.stored()).entries[0];
  assert.equal(healed.status, 'awaiting');
  assert.equal(healed.watchUntil, START + 60_000 + 120_000, '重查后该把收摊时刻补齐');

  // 补齐之后再唤醒一次（同一份 storage）：这次不该再发口令查询。
  const second = await createEnv({
    stored: await env.stored(),
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: true, packet: null } }),
      byId: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
      query: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  await second.flush();
  assert.equal(second.requests.filter((item) => item.url.includes('text-code')).length, 0, '补齐后不该再重查');
});

test('按 id 只读不进限速：看护轮询不刷新刻度，闲置很久后提交口令立即发出', async () => {
  // 历史里留着一条已报名、还没开奖的抽奖：看护会一直按 id 轮询红包本身（脚本版
  // watchLotteryDraw 同节奏）。按 id 只读与 /api/me 一样不进限速——既不等间隔，也不刷新
  // 刻度，刻度只由口令查询与领取 POST 推进。v0.11.0 之前扩展把只读也塞进限速：看护每轮询
  // 一次就把刻度顶到「刚刚」，于是用户闲置再久，提交一条口令也要排在后面显示「排队中」。
  const pending = { ...LOTTERY_PACKET, joined: true, draw_at: START + 7200_000, server_now: START };
  const stored = {
    entries: [entry({
      id: 'watch-1',
      code: LOTTERY_CODE,
      claimMode: 'manual',
      packetId: 'L1',
      matched: true,
      status: 'awaiting',
      watchUntil: START + 7200_000 + 120_000,
      packet: { id: 'L1', type: 'lottery', status: 'active', joined: true, creator: { username: 'alice', linuxdo_id: 1 }, draw_at: START + 7200_000, server_now: START },
    })],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastFinishedAt: START - 600_000,
  };
  const env = await createEnv({
    stored,
    handler: (url) => {
      if (url.endsWith('/api/me')) return sessionUser;
      if (url.endsWith('/api/hongbao/L1')) return { status: 200, body: pending };
      if (url.includes(encodeURIComponent(LOTTERY_CODE))) return { status: 200, body: pending };
      return { status: 200, body: { error: '口令不存在' } };
    },
  });
  await env.flush();
  // 唤醒不重查口令（v0.11.1）：刻度还是十分钟前那次查询留下的，看护直接从落库的收摊时刻装
  // 回来（按 id 只读，不进限速）。
  assert.equal((await env.stored()).lastFinishedAt, START - 600_000, '唤醒不该碰限速刻度');
  assert.equal(env.requests.filter((item) => item.url.includes('text-code')).length, 0,
    '唤醒不该重查待开启的口令');
  await env.advance(1000);
  assert.ok(env.requests.filter((item) => item.url.endsWith('/api/hongbao/L1')).length >= 1, '看护没有装回来');

  // 用户一小时后才回来用面板：这期间看护一直按 3 秒节奏轮询红包本身。
  env.clock.now = START + 3600_000;
  const mark = env.requests.length;
  await env.advance(30_000);
  const polls = env.requests.slice(mark).filter((item) => item.url.endsWith('/api/hongbao/L1'));
  assert.ok(polls.length >= 8, '看护该按 3 秒节奏轮询，实际 ' + polls.length + ' 次');
  assert.equal(polls[1].at - polls[0].at, 3000, '看护轮询节奏是 3 秒');
  assert.equal((await env.stored()).lastFinishedAt, START - 600_000, '看护轮询不得刷新限速刻度');

  // 这时提交一条口令：口令查询立刻发出——上一次查询已经过去一小时，面板不该显示「排队中」。
  const submitted = await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE, charset: 'text' }], claimMode: 'manual' });
  assert.equal(submitted.ok, true);
  await env.flush();
  const queried = env.requests.filter((item) => item.url.includes(encodeURIComponent(HAPPY_CODE)));
  assert.equal(queried.length, 1, '新口令的查询该发出去');
  assert.equal(queried[0].at, env.clock.now, '新口令的查询该立刻发出，不再等一个间隔');
  const row = (await env.send({ type: 'hb:state:get' })).state.entries
    .find((item) => item.code === HAPPY_CODE);
  assert.equal(row.status, 'done', '新口令该立刻查完，而不是停在排队中');
});

test('唤醒不重弹领取卡片：待开启条目原地待着，刚提交的口令立刻发出', async () => {
  // 用户报的现象（v0.11.1 修）：闲置很久之后打开面板，历史里留着一条古法「待开启」的口令。
  // 旧行为是唤醒时把它降级回队列、重查一遍口令——重查走的正是古法那条路，于是领取卡片又弹
  // 一次，而这次重查占掉的间隔（刻度被顶到「刚刚」）会把紧接着提交的口令挤成「排队中」，
  // 等满一个间隔才轮到它。
  const stored = {
    entries: [entry({
      id: 'old-1',
      code: HAPPY_CODE,
      claimMode: 'manual',
      status: 'awaiting',
      packetId: 'p1',
      matched: true,
      lines: [{ text: '恭喜发财，大吉大利', tone: 'normal' }, { text: '等待手动开启', tone: 'muted' }],
      result: '等待手动开启',
      packet: { id: 'p1', type: 'random', status: 'active', creator: { username: 'alice', linuxdo_id: 1 } },
    })],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastFinishedAt: START - 600_000,
  };
  const env = await createEnv({
    stored,
    handler: (url) => (url.endsWith('/api/me') ? sessionUser : { status: 200, body: ACTIVE_PACKET }),
  });
  await env.flush();

  assert.equal(env.requests.filter((item) => item.url.includes('text-code')).length, 0, '唤醒不该重查待开启的口令');
  assert.equal(env.cardWindows.length, 0, '唤醒不该把领取卡片再弹一次');
  assert.equal((await env.stored()).lastFinishedAt, START - 600_000, '唤醒不该顶限速刻度');
  const woke = await env.send({ type: 'hb:state:get' });
  assert.equal(woke.state.entries[0].status, 'awaiting');
  assert.equal(woke.state.entries[0].result, '等待手动开启', '待开启的条目不再重查，行里的结果照旧');

  // 紧接着提交一条新口令：刻度还是十分钟前那次查询留下的，它该立刻发出去。
  await env.send({ type: 'hb:submit', codes: [{ code: HAPPY_CODE_2, charset: 'text' }], claimMode: 'manual' });
  await env.flush();
  const queried = env.requests.filter((item) => item.url.includes(encodeURIComponent(HAPPY_CODE_2)));
  assert.equal(queried.length, 1, '新口令该立刻发出');
  assert.equal(queried[0].at, env.clock.now);
  const rows = (await env.send({ type: 'hb:state:get' })).state.entries;
  assert.deepEqual(plain(rows.map((item) => item.status)), ['awaiting', 'awaiting'],
  '两条都停在待开启，没有谁卡在排队中');
  // 查询照旧把领取卡片弹出来：这条正常路径没有变，变的只是「唤醒时不再补弹一次」。
  assert.equal(env.cardWindows.length, 1, '查到可领的红包照旧弹领取卡片');
  assert.match(env.cardWindows[0].url, /\?id=.*&view=claim$/);
});

test('停靠/悬浮决定点图标做什么：后台按显示方式切侧边栏行为与 popup', async () => {
  const env = await createEnv({ handler: okQuery({ error: '口令不存在' }) });
  // 默认悬浮：popup 留着，图标点击不归侧边栏。
  assert.deepEqual(plain(env.panelBehavior), [{ openPanelOnActionClick: false }]);
  assert.deepEqual(plain(env.popups), [{ popup: 'popup.html' }]);

  await env.send({ type: 'hb:state:patch', patch: { settings: { display: 'sidebar' } } });
  await env.flush();
  assert.deepEqual(plain(env.panelBehavior), [
    { openPanelOnActionClick: false },
    { openPanelOnActionClick: true },
  ], '切到停靠没有把图标点击交给侧边栏');
  assert.deepEqual(plain(env.popups), [{ popup: 'popup.html' }, { popup: '' }],
    '切到停靠没有清掉 popup');

  // 别的设置改动不该重放（图标行为只跟显示方式有关）。
  await env.send({ type: 'hb:state:patch', patch: { settings: { gapExtraMs: 1000 } } });
  await env.flush();
  assert.equal(env.popups.length, 2, '显示方式没变却又写了一次图标设置');

  await env.send({ type: 'hb:state:patch', patch: { settings: { display: 'panel' } } });
  await env.flush();
  assert.deepEqual(plain(env.panelBehavior).at(-1), { openPanelOnActionClick: false }, '切回悬浮没把侧边栏关掉');
  assert.deepEqual(plain(env.popups).at(-1), { popup: 'popup.html' }, '切回悬浮没恢复 popup');
});

test('worker 起来就按存储里的显示方式重放图标行为', async () => {
  // 扩展被重载时浏览器会把图标行为打回清单默认值，存储里的选择要在 worker 起来时补回来。
  const env = await createEnv({
    stored: { entries: [], removed: [], settings: { display: 'sidebar' }, paused: false, pausedReason: '', lastFinishedAt: 0 },
    handler: okQuery({ error: '口令不存在' }),
  });
  await env.flush();
  assert.deepEqual(plain(env.panelBehavior), [{ openPanelOnActionClick: true }], '唤醒后没有把图标交给侧边栏');
  assert.deepEqual(plain(env.popups), [{ popup: '' }], '唤醒后没有清掉 popup');
});

