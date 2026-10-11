/* 红包详情窗口。
 *
 * v0.9.7 起红包卡片不再挤进面板：弹出面板受浏览器弹窗高度上限（600px）限制，卡片按原尺寸
 * （普通 384×624、抽奖 504×768）根本铺不下，会被 height: min() 压扁一截。面板点历史行的
 * 「开红包／参与抽选／查看」改为开一个独立小窗口，窗口里只放 envelope.js 那一张卡片。
 *
 * 卡片本体、样式与写操作链路原样复用（envelope.js + envelope.css）：领取与参与仍然只认卡片上的
 * 真实点击（envelope.js 校验 event.isTrusted），后台再校验条目状态、只放行一次请求；限速、队列、
 * 历史回写与开奖看护都在后台，跟卡片画在哪个页面无关。
 *
 * 窗口自己认领身份：红包条目 id 由面板写在 URL 上（card.html?id=…），窗口号记进
 * chrome.storage.session 的 hb-card-window，面板据此复用同一个窗口——同一个红包就把它拉到
 * 前面，换个红包就把旧窗口关掉、按新卡片重开一个，不会点一次开一个。
 */
'use strict';

(function () {
  const api = globalThis.HBApi;
  const envelope = globalThis.HBEnvelope;
  const CARD_WINDOW_KEY = 'hb-card-window';
  const STATE_KEY = 'hb-state-v1';

  const entryId = new URLSearchParams(location.search).get('id') || '';
  let windowId = null;

  function warn(message, error) {
    console.warn('[红包详情窗口] ' + message, error ?? '');
  }

  // 窗口里没有面板那种行级出口，出问题就写在窗口中央，别只留一屏黑。
  function fail(message) {
    warn(message);
    const box = document.getElementById('hb-card-error');
    if (box) {
      box.textContent = message;
      box.hidden = false;
    }
    return null;
  }

  function send(message) {
    return api.runtime.sendMessage(message).then((response) => {
      if (!response?.ok) warn(message.type + ' 被后台拒绝：' + (response?.error || '未知错误'));
      return response;
    }, (error) => {
      warn(message.type + ' 发不出去：后台暂不可用', error);
      return undefined;
    });
  }

  async function readPacket(packetId, network) {
    try {
      const response = await api.runtime.sendMessage({ type: 'hb:packet', id: packetId, refresh: network === true });
      return response?.ok ? response.packet : null;
    } catch {
      return null;
    }
  }

  /* --------------------------------- 窗口本身 --------------------------------- */

  // 窗口号留在会话存储里（storage.session 只活在这一次浏览器会话，重启即清），
  // 面板读它来复用窗口；窗口被关掉时自己清掉，面板下次点开就新开一个。
  async function rememberWindow() {
    try {
      await api.storage.session.set({ [CARD_WINDOW_KEY]: { windowId, entryId } });
    } catch (error) {
      warn('记录详情窗口失败，面板将无从复用这个窗口', error);
    }
  }

  async function forgetWindow() {
    try {
      const bag = await api.storage.session.get(CARD_WINDOW_KEY);
      // 只清自己那一条：换成别的红包时旧页面正在收尾，不能把新窗口刚写下的记录抹掉。
      if (bag?.[CARD_WINDOW_KEY]?.entryId === entryId) await api.storage.session.remove(CARD_WINDOW_KEY);
    } catch {
      // 清不掉也不影响：面板认窗口靠 windows.get，认不到就重开一个。
    }
  }

  // 按卡片尺寸收紧窗口：windows.create 的宽高是窗口外框，减掉浏览器自己的标题栏与边框，
  // 视口正好等于「卡片显示尺寸 + 遮罩留白」。屏幕装不下就不动（窗口跑到屏幕外更糟），
  // 卡片自己会按视口高度收住。
  async function fitWindow(packet) {
    if (windowId === null) return;
    const size = envelope.windowSize(packet);
    if (size.width > screen.availWidth || size.height > screen.availHeight) return;
    // 商家窗口管理器可能把第一次请求打个折扣，量到差得多就再摆一次，最多两轮。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const frameX = Math.max(0, window.outerWidth - window.innerWidth);
      const frameY = Math.max(0, window.outerHeight - window.innerHeight);
      if (Math.abs(window.innerWidth - size.width) <= 1 && Math.abs(window.innerHeight - size.height) <= 1) return;
      try {
        await api.windows.update(windowId, { width: size.width + frameX, height: size.height + frameY });
      } catch (error) {
        warn('调整详情窗口尺寸失败', error);
        return;
      }
    }
  }

  /* ---------------------------------- 入口 ---------------------------------- */

  async function main() {
    try {
      const current = await api.windows?.getCurrent();
      windowId = current?.id ?? null;
    } catch (error) {
      warn('取不到窗口号，尺寸与窗口复用退回浏览器默认行为', error);
    }
    if (!entryId) {
      fail('缺少红包信息，无法打开详情。');
      return;
    }
    const response = await send({ type: 'hb:state:get' });
    const entry = (response?.state?.entries || []).find((item) => item.id === entryId);
    if (!entry?.packet?.id) {
      fail('这条记录没有红包详情可看，可能已经在面板里被删掉了。');
      return;
    }
    if (!envelope) {
      fail('红包卡片脚本未加载，请重新打开这个窗口。');
      return;
    }
    await rememberWindow();
    // 先把窗口摆到卡片尺寸，卡片再淡入，避免先按默认大小闪一帧。
    await fitWindow(entry.packet);

    const packetId = entry.packet.id;
    const claimable = entry.status === 'awaiting' && entry.claimMode === 'manual';
    const handle = envelope.show({
      entry,
      packet: entry.packet,
      viewOnly: !claimable,
      // 领取／参与只是把这次真实点击转成一条 hb:claim，授权判定仍在后台。
      onWrite: () => send({ type: 'hb:claim', id: entryId, trusted: true }),
      onRefresh: (network) => readPacket(packetId, network),
      // 卡片被关掉（× / 确定 / 关闭）就等于关这个窗口；换卡片时 envelope.js 不触发它。
      onClose: () => window.close(),
    });
    if (!handle) {
      fail('红包卡片打开失败。');
      return;
    }
    // 面板是拿着历史里的快照开窗的，这里再补一次只读详情与会话，让卡片信息完整。
    const [fresh, session] = await Promise.all([
      readPacket(packetId, true),
      send({ type: 'hb:session' }),
    ]);
    const user = session?.ok && session.loggedIn
      ? { username: session.username, linuxdo_id: session.linuxdo_id ?? null }
      : null;
    handle.update({ packet: fresh || undefined, user });
    // 读不到最新详情时卡片显示的是历史里的快照，这与脚本版一致，不再另写提示。
    if (!fresh) warn('暂时读不到红包 ' + packetId + ' 的最新详情，显示本地记录。');
  }

  // 窗口被关掉（或改开别的红包）时，把会话存储里的窗口号收干净。
  window.addEventListener('pagehide', () => { forgetWindow(); });

  // 条目在面板里被删除或清空时，这个窗口留着也没有意义（旧的面板内卡片也是这么收的）。
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STATE_KEY]) return;
    const entries = changes[STATE_KEY].newValue?.entries;
    if (Array.isArray(entries) && !entries.some((item) => item.id === entryId)) window.close();
  });

  main();

  globalThis.HBCard = { entryId, fitWindow };
})();
