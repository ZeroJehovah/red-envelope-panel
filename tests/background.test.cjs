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
  let timerSeq = 0;

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.4.0' }),
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
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, info); },
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
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
    listeners,
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
  assert.equal(stored.lastStartedAt, env.requests[1].at);

  const state = await env.send({ type: 'hb:state:get' });
  assert.deepEqual(plain(state.state.entries.map((item) => item.status)), ['done', 'done']);
  assert.equal(state.state.entries[0].result, '未匹配: 口令不存在');
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

  const denied = await env.send({ type: 'hb:claim', id, trusted: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, '缺少有效的领取授权，未发送领取请求');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '没有真实点击授权就不发 POST');

  const claimed = await env.send({ type: 'hb:claim', id, trusted: true });
  assert.equal(claimed.ok, true);
  const posted = env.requests.filter((item) => item.method === 'POST');
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/hongbao\/p1\/grab$/);

  const entryAfter = claimed.state.entries[0];
  assert.equal(entryAfter.status, 'done');
  assert.equal(entryAfter.result, '领取成功: +1.23 LDC');
  assert.equal(entryAfter.lines[0].text, '恭喜发财，大吉大利');

  const again = await env.send({ type: 'hb:claim', id, trusted: true });
  assert.equal(again.ok, false);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '一次点击只放行一次请求');
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

test('worker 回收后，限速时间戳仍挡住提前请求', async () => {
  const env = await createEnv({
    stored: {
      entries: [entry({ id: 'wait', status: 'queued' })],
      removed: [],
      settings: {},
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
  const env = await createEnv({
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: false, packet: { ...LOTTERY_PACKET, joined: true } } }),
      byId: () => ({ status: 200, body: drawn }),
    }),
  });
  const submit = await env.send({ type: 'hb:submit', codes: [{ code: LOTTERY_CODE, charset: 'text' }], claimMode: 'manual' });
  await env.flush();

  const awaiting = submit.state.entries[0];
  assert.equal(awaiting.status, 'awaiting');
  assert.equal(awaiting.packet.type, 'lottery');
  assert.equal(awaiting.result, '等待手动参与抽选');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '古法不自动报名抽奖');

  const joined = await env.send({ type: 'hb:claim', id: awaiting.id, trusted: true });
  assert.equal(joined.ok, true);
  const posted = env.requests.filter((item) => item.method === 'POST');
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/hongbao\/L1\/grab$/);
  // 报名不是领取：行停在等待开奖，而不是“结果未确认”。
  assert.equal(joined.state.entries[0].status, 'awaiting');
  assert.equal(joined.state.entries[0].result, '已参与抽选，等待开奖');
  assert.equal(joined.state.entries[0].packet.joined, true);

  // 看护按 id 读红包，开奖后把中奖结果写回同一行。
  await env.advance(5000);
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'done');
  assert.equal(state.state.entries[0].result, '已中奖: +5.00 LDC（已到账）');
  assert.equal(state.state.paused, false);
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 1, '看护不发写请求');
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
  await env.send({ type: 'hb:claim', id: submit.state.entries[0].id, trusted: true });
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

test('重载已报名的抽奖只重新装看护，不重复报名', async () => {
  const stored = {
    entries: [entry({
      claimMode: 'manual',
      status: 'awaiting',
      packetId: 'L1',
      matched: true,
      packet: { id: 'L1', type: 'lottery', status: 'active', joined: true, creator: { username: 'alice', linuxdo_id: 1 }, draw_at: START + 60000, server_now: START },
    })],
    removed: [],
    settings: {},
    paused: false,
    pausedReason: '',
    lastStartedAt: 0,
  };
  const env = await createEnv({
    stored,
    handler: lotteryHandler({
      join: () => ({ status: 200, body: { joined: true, already: true, packet: null } }),
      byId: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true, status: 'drawn', drawn_at: START + 61000, count: 3, winners: [] } }),
      query: () => ({ status: 200, body: { ...LOTTERY_PACKET, joined: true } }),
    }),
  });
  await env.flush();
  const state = await env.send({ type: 'hb:state:get' });
  assert.equal(state.state.entries[0].status, 'awaiting');
  assert.equal(state.state.entries[0].result, '已参与抽选，等待开奖');
  assert.equal(env.requests.filter((item) => item.method === 'POST').length, 0, '已报名的口令不得再次报名');

  await env.advance(5000);
  const after = await env.send({ type: 'hb:state:get' });
  assert.equal(after.state.entries[0].status, 'done');
  assert.equal(after.state.entries[0].result, '未抽中');
});

