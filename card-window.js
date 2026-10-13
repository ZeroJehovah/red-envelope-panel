/* 红包详情窗口：卡片尺寸的换算 + 那几种窗口的开合与复用。
 *
 * 卡片尺寸沿用原站：普通红包 320×520、抽奖卡 420×640，再乘 --envelope-zoom（1.2）。窗口要给的
 * 视口＝卡片显示尺寸 + `.modal-overlay` 的留白（左右各 20px，上下 20/24px）；windows.create 的
 * 宽高是外框（视口 + 标题栏与边框），所以先按一个估量值要尺寸，窗口起来后由 card.js 用
 * `outer - inner` 的真实差值收紧一次（最多两轮）。屏幕装不下就不动尺寸，让卡片按视口收住。
 *
 * 窗口按卡片种类各留一个，窗口号记在 chrome.storage.session 的 `hb-card-window`（只活这一次
 * 浏览器会话，重启即清）：
 *   - `claim`：等着真实点击的领取卡片——口令查到可领的红包后由后台自动弹出（脚本版
 *     runEntry 里的 showClaimEnvelope / showLotteryEnvelope 的对应物），窗口里是封口视图；
 *   - `detail`：详情卡片——点历史行的红包按钮开出（脚本版 openHistoryPacket 的对应物）。
 * v0.13.0 起历史行一律开详情卡片，不再按条目状态挑窗口种类（那个按钮的名字就是「查看红包
 * 详情」）；卡片能不能写跟着**条目状态**走——`claimable(entry)` 为真时那张详情卡自己留着领取
 * 入口，领取卡片因此只由后台在「刚查到可领」时自动弹出创建。同一种卡片同一个红包就把它拉到
 * 前面，换了红包就把这一种的旧窗口收掉、按新卡片的尺寸重开一个（不走 `tabs.update` 去改已有
 * 窗口的地址：扩展页能不能被这样导航要看浏览器对扩展源给不给权限，关掉重开是同一件事，也不会
 * 留下「窗口开着、里面还是上一个红包」的将就状态）。领取卡片一旦落定（条目不再是 awaiting），
 * 窗口里画的就只剩结论，与详情卡片是同一件事了——那时点历史行直接把那个窗口拉到前面，不再
 * 多开一个。
 */
'use strict';

(function () {
  const api = globalThis.HBApi;
  const CARD_WINDOW_KEY = 'hb-card-window';
  const CARD_PAGE = 'card.html';
  const VIEW_CLAIM = 'claim';
  const VIEW_DETAIL = 'detail';

  // 卡片显示尺寸与外框估量（后四个值与 envelope.css 的留白、card.js 的收紧逻辑配套）。
  const CARD_BASE = {
    random: { width: 320, height: 520 },
    lottery: { width: 420, height: 640 },
  };
  const CARD_ZOOM = 1.2;
  const CARD_INSET_X = 40;       // .modal-overlay 左右各 20px
  const CARD_INSET_Y = 44;       // --edge-top 20 + --edge-bottom 24
  const FRAME_ESTIMATE_X = 16;   // 开窗前对「外框 - 视口」的估量，窗口起来后按真实差值收紧
  const FRAME_ESTIMATE_Y = 40;

  // 红包详情窗口要多大的视口（内尺寸），以及开窗时先按多大外框去要。
  function windowSize(packet) {
    const base = packet?.type === 'lottery' ? CARD_BASE.lottery : CARD_BASE.random;
    return {
      width: Math.round(base.width * CARD_ZOOM) + CARD_INSET_X,
      height: Math.round(base.height * CARD_ZOOM) + CARD_INSET_Y,
    };
  }

  function windowOuterSize(packet) {
    const size = windowSize(packet);
    return { width: size.width + FRAME_ESTIMATE_X, height: size.height + FRAME_ESTIMATE_Y };
  }

  // 条目的红包还等着点一下（古法）：这样的条目在哪儿打开都留着领取入口——后台自动弹出的领取
  // 卡片靠它决定挂不挂写入（v0.11.0），面板开出的详情卡也靠它（v0.13.0 起同样挂着「开红包」，
  // 关掉弹出的那张之后仍能领）。已经报过名的抽奖没有可点的动作（等开奖是后台看护的事）。
  function claimable(entry) {
    return Boolean(entry) && entry.status === 'awaiting' && entry.claimMode === 'manual'
      && entry.packet?.joined !== true;
  }

  function normalizeView(view) {
    return view === VIEW_DETAIL ? VIEW_DETAIL : VIEW_CLAIM;
  }

  function cardUrl(id, view) {
    return api.runtime.getURL(CARD_PAGE) + '?id=' + encodeURIComponent(id) + '&view=' + view;
  }

  // 会话存储里那两种卡片的窗口号；坏数据（旧版本留下的形状）一律当没有。
  async function readRecords() {
    try {
      const bag = await api.storage?.session?.get(CARD_WINDOW_KEY);
      const value = bag?.[CARD_WINDOW_KEY];
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  // 上一次开着的窗口还活着吗（被关掉后 windows.get 会失败，返回 null）。
  async function live(record) {
    if (!record?.windowId) return null;
    try {
      return await api.windows.get(record.windowId);
    } catch {
      return null;
    }
  }

  async function focus(windowId) {
    await api.windows.update(windowId, { focused: true }).catch(() => {});
  }

  // 卡片窗口自己登记（card.js 加载完就写），面板与后台靠它复用同一个窗口。
  async function remember(view, info) {
    const records = await readRecords();
    records[normalizeView(view)] = info;
    try {
      await api.storage?.session?.set({ [CARD_WINDOW_KEY]: records });
    } catch {
      // 记不上只是下次认不到这个窗口（会多开一个），不影响这一次开窗。
    }
  }

  // 窗口关掉时清掉自己那一条：另一种卡片的记录不能跟着丢。
  async function forget(view, entryId) {
    const records = await readRecords();
    const slot = normalizeView(view);
    if (records[slot]?.entryId !== entryId) return;
    delete records[slot];
    try {
      await api.storage?.session?.set({ [CARD_WINDOW_KEY]: records });
    } catch {
      // 清不掉也不影响：认窗口靠 windows.get，认不到就重开一个。
    }
  }

  // 开（或复用）详情窗口。entry 是调用方手里那条历史记录，packet 是它的红包快照。
  // 返回 { ok, action: 'focused' | 'created' | 'replaced', windowId } 或 { ok: false, error }。
  async function open(options = {}) {
    const id = String(options.id || '');
    const want = normalizeView(options.view);
    const entry = options.entry || null;
    const packet = options.packet || entry?.packet || null;
    if (!id || !packet?.id) return { ok: false, error: '这条记录没有红包详情可看' };
    if (!api.windows?.create) return { ok: false, error: '当前浏览器打不开红包详情窗口' };

    const records = await readRecords();
    const claim = await live(records[VIEW_CLAIM]);
    const detail = await live(records[VIEW_DETAIL]);

    // 领取卡片已经落定（条目不再是 awaiting）时它就是一张只读卡片，点历史行直接拉它到前面。
    if (want === VIEW_DETAIL && claim && records[VIEW_CLAIM].entryId === id && !claimable(entry)) {
      await focus(claim.id);
      return { ok: true, action: 'focused', windowId: claim.id };
    }
    const current = want === VIEW_CLAIM ? claim : detail;
    if (current && records[want].entryId === id) {
      await focus(current.id);
      return { ok: true, action: 'focused', windowId: current.id };
    }
    if (current) await api.windows.remove(current.id).catch(() => {});

    const size = windowOuterSize(packet);
    try {
      const created = await api.windows.create({
        url: cardUrl(id, want),
        type: 'popup',
        focused: true,
        width: size.width,
        height: size.height,
      });
      return { ok: true, action: current ? 'replaced' : 'created', windowId: created?.id ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '打开红包详情窗口失败' };
    }
  }

  globalThis.HBCardWindow = {
    open,
    remember,
    forget,
    claimable,
    windowSize,
    windowOuterSize,
    key: CARD_WINDOW_KEY,
    view: { claim: VIEW_CLAIM, detail: VIEW_DETAIL },
  };
})();
