/* 红包详情卡片（信封弹窗）。
 *
 * 从脚本版 browser/userscripts/linuxdo-hongbao-code-sidebar.user.js（v2.35.0）移植
 * ENVELOPE_MARKUP / LOTTERY_MARKUP 与 renderEnvelopeClaims / renderEnvelopeResult /
 * renderLotteryCard / syncLotteryClock 等函数：封口视图点「开」领取，开启后展示金额、
 * 领取进度、已领总额与领取记录；抽奖卡片展示倒计时、参与者与中奖公示。
 *
 * 与脚本版的形态差异（记录在 docs/AGENTS.md）：
 *   - 卡片挂在红包详情窗口自己的影子 DOM 里（样式随包的 envelope.css）：既不挂在网页上，
 *     也不在面板页面里——弹出面板受浏览器弹窗高度上限（600px）限制，卡片按原尺寸放不下，
 *     从 v0.9.7 起由面板另开一个独立小窗口来放卡片；
 *   - 一次只展示一张卡片，没有脚本版的多卡堆叠与「全部关闭」；
 *   - 关闭卡片不会把条目改写成「未领取」：面板里条目留在「待开启」，可以再次打开；
 *   - 详情卡片（历史行开出）在条目还等着点一下（古法）时也挂着「开红包」：这件事跟着**条目
 *     状态**走而不是跟着窗口走（v0.13.0），于是关掉自动弹出的那张卡片之后仍能领，不必重新输
 *     一遍口令。脚本版没有这个状态——它关掉卡片就把行记成「未领取: 已关闭红包」，历史卡片**
 *     永远只读**（openHistoryPacket 从不挂开启入口）；
 *   - 头像用原站返回的地址加载（和原站 claimAvatarSrc 一致），取不到或不合法时
 *     回落到原站那套确定性 SVG；协议请求仍然只发往 hb.unsnow.org。
 *
 * 写操作仍然只认真实点击：卡片上的「开」/「参与抽选」转成一次 hb:claim，
 * 后台还会再校验条目状态，一次点击只放行一条请求。
 *
 * 显示内容按原站 app.js（v=a0a5b8fa）逐条对齐：未领取的终态（已领完/已过期/已取消）
 * 与专属红包同样把金额显示成 0.00；卡面不再自加原站没有的「×」按钮；
 * 领取记录刷新时保持滚动位置；抽奖卡片已报名时按钮显示「已参与抽选」而不是消失。
 */
'use strict';

(function () {
  const P = globalThis.HBProtocol;
  const HOST_ID = 'hb-envelope-host';
  const STYLE_HREF = 'envelope.css';
  const POLL_INTERVAL_MS = 4000;   // 卡片开着时的刷新节奏；后台限速会让它不会更密

  // 卡片的显示尺寸与开窗尺寸（windowSize / windowOuterSize）在 card-window.js：面板、后台与
  // 详情窗口都要用同一份换算，卡片这边只负责画。

  // 这里只放卡片「里面」的两块视图：卡片本体由 createNode 建出来，class 已经在了，
  // 若这里再套一层 .redpacket-envelope，卡片的 padding、圆角与 520px 定高会叠两遍。
  const ENVELOPE_MARKUP = `
      <!-- 封口（未开启）视图 -->
      <div id="envelope-closed-view" style="display: flex; flex-direction: column; align-items: center; justify-content: space-between; height: 100%; width: 100%;">
          <div class="envelope-top">
            <div class="envelope-sender" id="env-sender-name"></div>
            <div class="envelope-wish" id="env-wish-text">恭喜发财，大吉大利</div>
            <img class="envelope-creator-avatar" id="env-creator-avatar" alt="发红包用户头像">
          </div>
        <button class="envelope-open-btn" id="btn-open-packet">开</button>
        <div class="envelope-footer">红包口令: <span id="env-footer-code">----------</span></div>
      </div>

      <!-- 开启后的结果视图 -->
      <div id="envelope-opened-view" class="envelope-details">
        <div style="text-align: center; margin-top: 20px;">
          <div class="envelope-sender" id="env-opened-title" style="margin-bottom: 24px;">已成功领取红包</div>
          <div class="details-amount" id="env-claimed-amount">0.00<span>LDC</span></div>
          <div class="details-status" id="env-packet-details">拼手气红包 - 已存入余额</div>
        </div>
        <div class="envelope-result-overview">
          <div class="envelope-result-stat">
            <span>领取进度</span>
            <strong id="env-claimed-count">0 / 0</strong>
          </div>
          <div class="envelope-result-stat">
            <span>已领总额</span>
            <strong id="env-claimed-total">0.00 LDC</strong>
          </div>
        </div>
        <div class="envelope-claims-list" id="env-claims-list"></div>
        <button class="envelope-close-btn">确定</button>
      </div>`;

  const LOTTERY_MARKUP = `<section id="lottery-view" class="lottery-view" hidden aria-labelledby="lottery-title">
        <header class="lottery-header">
          <div class="envelope-sender" id="lottery-sender"></div>
          <h3 id="lottery-title">即时随机抽红包</h3>
          <div id="lottery-countdown" class="lottery-countdown" role="timer"></div>
          <p id="lottery-summary"></p>
          <p id="lottery-personal" role="status"></p>
          <small id="lottery-connection" role="status"></small>
        </header>
        <div class="lottery-scroll" tabindex="0" aria-label="实时参与及中奖记录">
          <section id="lottery-winners-section" hidden><h4 id="lottery-winners-title">中奖公示</h4><div id="lottery-winners"></div></section>
          <section><h4 id="lottery-participants-title">参与者（0）</h4><div id="lottery-participants"></div></section>
        </div>
        <footer class="lottery-actions">
          <button type="button" class="btn btn-primary" id="lottery-join">参与抽选</button>
          <button type="button" class="btn btn-secondary" id="lottery-close">关闭</button>
        </footer>
      </section>`;

  /* ---------------------------------- 头像 ---------------------------------- */

  // 原站的确定性头像兜底（同一套 SVG 与配色）。
  function hashText(value) {
    const textValue = String(value || 'hongbao');
    let hash = 0;
    for (let index = 0; index < textValue.length; index += 1) {
      hash = ((hash << 5) - hash + textValue.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
  }

  function avatarKeyFor(value) {
    return 'avatar-' + (hashText(value) % 6 + 1);
  }

  function getAvatarSVG(avatarId) {
    const colors = {
      'avatar-1': '#2d5da1',
      'avatar-2': '#ff4d4d',
      'avatar-3': '#4d9f4d',
      'avatar-4': '#ff9f43',
      'avatar-5': '#8f7bf3',
      'avatar-6': '#86868b',
    };
    const color = colors[avatarId] || '#2d5da1';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <path d="M 12 12 Q 50 5, 88 12 Q 95 50, 88 88 Q 50 95, 12 88 Q 5 50, 12 12 Z" fill="${color}" stroke="#2d2d2d" stroke-width="4.5" />
      <path d="M 50 24 Q 68 24, 68 42 Q 68 60, 50 60 Q 32 60, 32 42 Q 32 24, 50 24" fill="#ffffff" stroke="#2d2d2d" stroke-width="3.5" />
      <path d="M 24 82 Q 22 64, 40 64 Q 50 64, 60 64 Q 78 64, 76 82 Z" fill="#ffffff" stroke="#2d2d2d" stroke-width="3.5" />
      <line x1="44" y1="42" x2="44" y2="46" stroke="#2d2d2d" stroke-width="3" stroke-linecap="round"/>
      <line x1="56" y1="42" x2="56" y2="46" stroke="#2d2d2d" stroke-width="3" stroke-linecap="round"/>
      <path d="M 44 50 Q 50 54, 56 50" fill="none" stroke="#2d2d2d" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;
  }

  function getAvatarDataURI(avatarId) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(getAvatarSVG(avatarId));
  }

  function fallbackAvatar(user) {
    return getAvatarDataURI(avatarKeyFor(user?.linuxdo_id ?? user?.username ?? 'hongbao'));
  }

  // 头像地址就用原站返回的那一个（原站 claimAvatarSrc：有 avatar_url 就用它，没有才兜底），
  // 只挡掉拿不到或不是 http(s) 的取值，避免把奇怪协议塞进 img。
  function remoteAvatarUrl(user) {
    const raw = user?.avatar_url;
    if (typeof raw !== 'string' || !raw) return '';
    try {
      const url = new URL(raw, P.HB_SITE_URL);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function setAvatar(image, user) {
    if (!image) return;
    const src = remoteAvatarUrl(user);
    if (!src) {
      image.onerror = null;
      image.src = fallbackAvatar(user);
      return;
    }
    image.onerror = () => {
      image.onerror = null;
      image.src = fallbackAvatar(user);
    };
    image.src = src;
  }

  /* -------------------------------- 宿主与卡片 -------------------------------- */

  let host = null;
  let overlay = null;
  let card = null;
  let shadowRoot = null;
  // 卡片样式随包，但要等它到位再画卡片：<link> 是异步的，暗色主题下会先画一帧没样式的卡片
  // （就是「底部按钮先亮一下再变暗」那一下闪）。所以先把同包的 css 读成一张 constructable
  // stylesheet，之后每次开卡片都同步挂上；读不到就退回 <link>，并在样式到位前先藏着卡片。
  let sheet = null;

  function markStyled() {
    if (host) host.style.visibility = '';
  }

  function loadStyles() {
    // 只读同包资源（不是远程代码）；自检页是 file://，没有这层 API，会走 <link> 兜底。
    const url = globalThis.chrome?.runtime?.getURL?.(STYLE_HREF);
    if (!url || typeof CSSStyleSheet !== 'function') return;
    fetch(url).then((response) => (response.ok ? response.text() : '')).then((css) => {
      if (!css || sheet) return;
      const next = new CSSStyleSheet();
      next.replaceSync(css);
      sheet = next;
      if (shadowRoot) shadowRoot.adoptedStyleSheets = [next];
      markStyled();
    }).catch(() => {
      // 读不到就继续用 <link>，卡片照样能开。
    });
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadowRoot = host.attachShadow({ mode: 'open' });
    if (sheet) {
      shadowRoot.adoptedStyleSheets = [sheet];
    } else {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = STYLE_HREF;
      link.addEventListener('load', markStyled, { once: true });
      shadowRoot.append(link);
      // 样式没到之前先不把没样式的卡片画出来；同时留个兜底，别真的藏住不显示。
      host.style.visibility = 'hidden';
      setTimeout(markStyled, 400);
    }
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    shadowRoot.append(overlay);
    document.body.append(host);
    return overlay;
  }

  function createNode(packet) {
    const node = document.createElement('div');
    node.className = 'redpacket-envelope';
    node.tabIndex = -1;
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', '红包');
    if (P.isLottery(packet)) {
      node.classList.add('is-lottery');
      node.innerHTML = LOTTERY_MARKUP;
      const view = node.querySelector('#lottery-view');
      if (view) view.hidden = false;
    } else {
      node.innerHTML = ENVELOPE_MARKUP;
    }
    return node;
  }

  // replaced：这次关闭是因为马上要换一张卡片（show() 会先收起上一张），不是用户关掉的，
  // 调用方的 onClose 就不该被触发——红包详情窗口正是靠 onClose 关窗口。
  function closeCard(replaced) {
    const current = card;
    if (!current) return;
    card = null;
    current.closed = true;
    stopClock(current);
    stopPolling(current);
    current.node.remove();
    if (overlay) overlay.classList.remove('active');
    // 宿主是固定定位、盖住整个页面的层：关掉卡片后必须连它一起撤掉，
    // 否则留一层透明宿主在 DOM 里，页面上的点击会被它整个吞掉（打开下一张卡片时重建）。
    if (host) host.remove();
    host = null;
    overlay = null;
    shadowRoot = null;
    if (replaced === true) return;
    if (typeof current.onClose === 'function') {
      try {
        current.onClose();
      } catch {
        // 面板的收尾回调不该影响关闭本身。
      }
    }
  }

  function setBusy(state, busy) {
    state.busy = busy;
    const open = state.node.querySelector('#btn-open-packet');
    if (open) {
      open.disabled = busy;
      open.classList.toggle('spinning', busy);
    }
    // 详情卡片里那颗按钮是横条，不做翻转动画，直接把字换成进行中。
    const inline = state.node.querySelector('#btn-open-packet-detail');
    if (inline) {
      inline.disabled = busy;
      inline.textContent = busy ? '正在开启…' : '开红包';
    }
    const join = state.node.querySelector('#lottery-join');
    if (join && !join.hidden) {
      join.disabled = busy;
      join.textContent = busy ? '正在参与…' : '参与抽选';
    }
  }

  /* ------------------------------- 普通红包视图 ------------------------------- */

  function renderClosed(state) {
    const packet = state.packet;
    const node = state.node;
    const set = (selector, value) => {
      const target = node.querySelector(selector);
      if (target) target.textContent = value;
    };
    set('#env-sender-name', '来自 ' + (packet.creator?.username || '') + ' 的红包');
    set('#env-wish-text', packet.wish || '恭喜发财，大吉大利');
    set('#env-footer-code', packet.code || state.entry?.code || '');
    setAvatar(node.querySelector('#env-creator-avatar'), packet.creator);
  }

  // 领取记录：手气王排在最前，其余按时间倒序（与脚本版 renderEnvelopeClaims 一致）。
  function renderClaims(node, packet) {
    const count = node.querySelector('#env-claimed-count');
    if (count) count.textContent = (Number(packet.claimed_count) || 0) + ' / ' + (Number(packet.count) || 0);
    const total = node.querySelector('#env-claimed-total');
    if (total) total.textContent = (Number(packet.claimed_amount) || 0).toFixed(2) + ' LDC';

    const list = node.querySelector('#env-claims-list');
    if (!list) return;
    // 原站重画领取记录时会接着原来的滚动位置（renderEnvelopeClaims 里的 scrollTop）。
    const scrollTop = list.scrollTop;
    const luckiest = (claim) => packet.type === 'random' && packet.luckiest_claim_id != null
      && String(claim.share_id) === String(packet.luckiest_claim_id);
    const claims = (Array.isArray(packet.claims) ? packet.claims : [])
      .filter((claim) => claim && typeof claim === 'object')
      .slice()
      .sort((a, b) => Number(luckiest(b)) - Number(luckiest(a)) || Number(b.at || 0) - Number(a.at || 0));
    list.replaceChildren();
    if (!claims.length) {
      const empty = document.createElement('div');
      empty.className = 'envelope-claims-empty';
      empty.textContent = '暂时还没有领取记录';
      list.append(empty);
      return;
    }
    for (const claim of claims) {
      const row = document.createElement('div');
      row.className = 'envelope-claim-row';
      const user = document.createElement('div');
      user.className = 'envelope-claim-user';
      const avatar = document.createElement('img');
      avatar.alt = '';
      avatar.loading = 'lazy';
      setAvatar(avatar, claim);
      const name = document.createElement('span');
      name.textContent = claim.username || '';
      user.append(avatar, name);
      const amount = document.createElement('div');
      amount.className = 'envelope-claim-amount';
      const value = document.createElement('strong');
      value.textContent = (Number(claim.amount) || 0).toFixed(2) + ' LDC';
      amount.append(value);
      if (luckiest(claim)) {
        const badge = document.createElement('span');
        badge.className = 'envelope-luckiest';
        badge.textContent = '手气王';
        amount.append(badge);
      }
      row.append(user, amount);
      list.append(row);
    }
    list.scrollTop = scrollTop;
  }

  function renderResult(state, outcome, packet, stale = false) {
    const node = state.node;
    const closed = node.querySelector('#envelope-closed-view');
    const opened = node.querySelector('#envelope-opened-view');
    if (!closed || !opened) return;
    closed.style.display = 'none';
    opened.style.display = 'flex';
    const set = (selector, value) => {
      const target = node.querySelector(selector);
      if (target) target.textContent = value;
    };
    const lines = Array.isArray(outcome.lines) ? outcome.lines : [];
    const last = lines[lines.length - 1];
    const success = typeof last?.text === 'string' && last.text.startsWith('领取成功:');
    const creator = packet?.creator?.username || '';
    set('#env-opened-title', outcome.title || (success
      ? '已成功领取 ' + creator + ' 的红包'
      : (outcome.already ? '你已经领取过这个红包' : '领取失败')));
    const amount = outcome.amount ?? (outcome.already ? packet?.mine : null);
    const value = node.querySelector('#env-claimed-amount');
    if (value) {
      value.hidden = amount == null;
      value.replaceChildren(document.createTextNode((Number(amount) || 0).toFixed(2)));
      const unit = document.createElement('span');
      unit.textContent = 'LDC';
      value.append(unit);
    }
    set('#env-packet-details', outcome.detail ?? (success
      ? P.packetStatusText(packet.status) + ' - 口令 ' + (packet.code || state.entry?.code || '')
        + (stale ? '（领取记录暂未更新）' : '')
      : (outcome.already ? '已存入你的 LDC 账户' : P.linesText(lines))));
    const overview = node.querySelector('.envelope-result-overview');
    if (overview) overview.hidden = !packet;
    const claims = node.querySelector('#env-claims-list');
    if (claims) claims.hidden = !packet;
    if (packet) renderClaims(node, packet);
    // 详情卡片（历史行开出）里那条领取入口：条目还等着点一下时它才在。
    syncDetailAction(state);
  }

  // 详情卡片里的「开红包」：条目还等着点一下（古法）时，历史行开出来的这张卡片照样能领——
  // 关掉后台自动弹出的那张领取卡片之后，这里是唯一能领的地方（脚本版没这个状态：它关掉卡片
  // 就把行记成「未领取: 已关闭红包」，想领只能重新输一遍口令）。已经有结论（领取成功）或这张
  // 卡片本来就只读时不出现；领取失败仍留着，用户可以再点一次（授权与在途标记都在后台把关）。
  function syncDetailAction(state) {
    if (!state.detail || state.viewOnly) return null;
    const view = state.node.querySelector('#envelope-opened-view');
    if (!view) return null;
    let button = view.querySelector('#btn-open-packet-detail');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = 'btn-open-packet-detail';
      button.className = 'envelope-detail-open';
      button.textContent = '开红包';
      const tail = view.querySelector('.envelope-close-btn');
      view.insertBefore(button, tail || null);
      button.addEventListener('click', (event) => { runWrite(state, event); });
    }
    button.hidden = Boolean(state.outcome);
    return button;
  }

  // 历史条目（只读）：结论直接由红包快照推出来，没有领取请求也没有授权入口。
  // 金额照原站处理：终态（已领完/已过期/已取消）与专属红包都显示 0.00，
  // 不是自己领的也照显——原站 showEnvelopeResult 传的就是 0，不按「有没有 mine」抹掉。
  function storedOutcome(state) {
    const packet = state.packet;
    const outcome = P.packetOutcome(packet, state.user);
    if (outcome) return outcome;
    return {
      title: '来自 ' + (packet.creator?.username || '') + ' 的红包',
      detail: '尚未领取此红包',
      lines: [],
    };
  }

  /* ------------------------------- 抽奖卡片视图 ------------------------------- */

  function remainingMs(state) {
    const drawAt = Number(state.packet?.draw_at);
    if (!Number.isFinite(drawAt)) return null;
    return drawAt - (Date.now() + (state.serverOffset || 0));
  }

  function lotteryEnded(state) {
    const packet = state.packet;
    return Boolean(packet?.drawn_at) || packet?.status !== 'active';
  }

  function stopClock(state) {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
  }

  function syncClock(state) {
    if (state.closed) return;
    const node = state.node;
    if (!node.querySelector('#lottery-view')) return;
    const ended = lotteryEnded(state);
    const remaining = ended ? null : remainingMs(state);
    const countdown = node.querySelector('#lottery-countdown');
    if (countdown) {
      countdown.textContent = ended ? '抽选已结束'
        : remaining === null ? '等待抽选'
          : (remaining > 0 ? Math.ceil(remaining / 1000) + ' 秒' : '正在公布结果…');
    }
    const join = node.querySelector('#lottery-join');
    if (join && !join.hidden) {
      join.disabled = Boolean(state.busy) || Boolean(state.packet?.joined)
        || (remaining !== null && remaining <= 0);
    }
    if (ended) {
      stopClock(state);
      return;
    }
    if (!state.timer) state.timer = setInterval(() => syncClock(state), 1000);
  }

  function renderLottery(state) {
    const node = state.node;
    if (!node.querySelector('#lottery-view')) return;
    const packet = state.packet;
    const user = state.user;
    const set = (selector, value) => {
      const target = node.querySelector(selector);
      if (target) target.textContent = value;
    };
    state.joined = Boolean(packet.joined);
    const serverNow = Number(packet.server_now);
    state.serverOffset = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
    const participants = Array.isArray(packet.participants) ? packet.participants : [];
    const winners = Array.isArray(packet.winners) ? packet.winners : [];
    const ended = lotteryEnded(state);
    const winner = P.lotteryWinner(packet, user);
    const creator = P.isPacketCreator(packet, user);

    set('#lottery-sender', '来自 ' + (packet.creator?.username || '') + ' · ' + (packet.wish || ''));
    set('#lottery-summary', (packet.distribution_type === 'equal' ? '普通红包' : '拼手气红包')
      + ' · ' + Number(packet.total_amount || 0).toFixed(2) + ' LDC · 抽选 ' + (Number(packet.count) || 0) + ' 人');
    set('#lottery-personal', ended
      ? (winner ? '你已中奖 ' + (Number(winner.amount) || 0).toFixed(2) + ' LDC · ' + P.lotteryPayoutText(winner.payout_status)
        : creator ? '结果已公示，未发出的份额已关闭且不会扣款'
          : packet.joined ? '本次未抽中，感谢参与' : '报名已截止，仅可查看记录')
      : creator ? '这是你发出的红包，参与名单实时更新'
        : packet.joined ? '已参与，等待倒计时结束自动抽选'
          : (state.error || (state.viewOnly ? '请到红包站手动参与抽选' : '点击参与抽选，截止前每人可参与一次')));
    // 原站平时这一行是空的，只有 EventSource 掉线时才写「连接恢复中，正在定时更新」。
    set('#lottery-connection', state.connectionNote || '');

    const winnersSection = node.querySelector('#lottery-winners-section');
    if (winnersSection) winnersSection.hidden = !ended;
    set('#lottery-winners-title', '中奖公示（' + winners.length + ' / ' + (Number(packet.count) || 0) + '）');
    set('#lottery-participants-title', '所有参与者（' + participants.length + '）');

    for (const [selector, people, result] of [
      ['#lottery-winners', winners, (person) => (Number(person.amount || 0).toFixed(2) + ' LDC\n' + P.lotteryPayoutText(person.payout_status))],
      ['#lottery-participants', participants, (person) => (ended
        ? (winners.some((item) => String(item.linuxdo_id) === String(person.linuxdo_id)) ? '已中奖' : '未抽中') : '')],
    ]) {
      const list = node.querySelector(selector);
      if (!list) continue;
      list.replaceChildren();
      for (const person of people) {
        const row = document.createElement('div');
        row.className = 'lottery-person';
        const avatar = document.createElement('img');
        avatar.alt = '';
        avatar.loading = 'lazy';
        setAvatar(avatar, person);
        const nameBox = document.createElement('div');
        nameBox.className = 'lottery-person-name';
        const name = document.createElement('strong');
        name.textContent = person.name || person.username || '';
        const handle = document.createElement('small');
        handle.textContent = '@' + (person.username || '');
        nameBox.append(name, handle);
        const detail = document.createElement('div');
        detail.className = 'lottery-person-result';
        const [amount, status] = String(result(person)).split('\n');
        for (const [tag, text] of [[selector === '#lottery-winners' ? 'strong' : 'small', amount], ['small', status]]) {
          if (!text) continue;
          const lineNode = document.createElement(tag);
          lineNode.textContent = text;
          detail.append(lineNode);
        }
        row.append(avatar, nameBox, detail);
        list.append(row);
      }
      if (!people.length) {
        const empty = document.createElement('p');
        empty.className = 'lottery-empty';
        empty.textContent = selector === '#lottery-winners' ? '无人参与，红包已关闭，未扣款。' : '还没有人参与';
        list.append(empty);
      }
    }

    // 按钮只在还能报名时出现：已结束、自己发的、已报名、历史卡片都不给写入动作。
    const join = node.querySelector('#lottery-join');
    if (join) {
      // 原站：已报名不隐藏按钮，改成禁用并显示「已参与抽选」（renderLottery）。
      join.hidden = state.viewOnly || ended || creator;
      join.disabled = Boolean(state.busy) || Boolean(packet.joined);
      join.textContent = state.busy ? '正在参与…' : packet.joined ? '已参与抽选' : '参与抽选';
    }
    syncClock(state);
  }

  /* --------------------------------- 刷新 ---------------------------------- */

  function stopPolling(state) {
    if (!state.poll) return;
    clearInterval(state.poll);
    state.poll = null;
  }

  // 卡片开着时按节奏刷新红包快照：已报名的抽奖由后台看护轮询，面板读内存即可；
  // 还没报名（或读完开奖名单后）才让后台补一次网络查询。
  function startPolling(state) {
    if (state.poll || state.closed || typeof state.onRefresh !== 'function') return;
    state.poll = setInterval(() => {
      if (state.closed) {
        stopPolling(state);
        return;
      }
      const network = !(state.joined && !lotteryEnded(state));
      Promise.resolve(state.onRefresh(network)).then((fresh) => {
        if (state.closed || !fresh || !fresh.id) return;
        state.packet = fresh;
        if (P.isLottery(fresh)) {
          state.connectionNote = '';
          renderLottery(state);
        }
        if (lotteryEnded(state)) {
          stopPolling(state);
          stopClock(state);
        }
      }, () => {
        // 这一轮没读到：用原站掉线时的同一句提示，读回来时上面会自动清掉。
        if (state.closed) return;
        state.connectionNote = '连接恢复中，正在定时更新';
        if (P.isLottery(state.packet)) renderLottery(state);
      });
    }, POLL_INTERVAL_MS);
  }

  /* --------------------------------- 写入 ---------------------------------- */

  async function runWrite(state, event) {
    if (state.closed || state.busy || state.viewOnly || state.outcome) return;
    // 写请求只认真实点击：合成点击（脚本、自动化）在这里就被挡下。
    if (!event || event.isTrusted !== true) return;
    if (typeof state.onWrite !== 'function') return;
    const packet = state.packet;
    if (P.isLottery(packet) && (packet.status !== 'active' || packet.drawn_at || packet.joined)) return;
    setBusy(state, true);
    let result = null;
    try {
      result = await state.onWrite();
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    state.busy = false;
    if (state.closed) return;
    setBusy(state, false);
    const label = P.isLottery(packet) ? '参与失败: ' : '领取失败: ';
    if (!result || result.ok !== true) {
      const reason = result?.error || '操作未完成';
      state.error = label + reason;
      const outcome = { lines: [P.line(label + reason, 'error')] };
      if (P.isLottery(packet)) renderLottery(state);
      else renderResult(state, outcome, state.packet);
      return;
    }
    state.error = '';
    state.outcome = result.outcome || {};
    let fresh = result.packet && result.packet.id ? result.packet : null;
    // 报名成功不是终局：卡片切成等待开奖的抽奖视图，继续由看护与刷新更新。
    if (state.outcome.joined) {
      state.packet = fresh || { ...packet, joined: true };
      renderLottery(state);
      startPolling(state);
      return;
    }
    let stale = false;
    if (fresh) state.packet = fresh;
    // 领取成功先把结论铺出来（金额与自己的那一行分开来）：回执里那份快照是点「开」之前的，
    // 自己的这一笔还没写进去，所以紧接着补一次只读详情——与脚本版 openEnvelopeCard 同一件事
    // （成功先落盘，这一读失败也不重发领取）。这一读是一次网络往返，所以先按「领取记录暂未
    // 更新」画出来，读回来再就地补上领取记录。
    renderResult(state, state.outcome, state.packet, state.outcome.amount !== undefined);
    if (state.outcome.amount === undefined || typeof state.onRefresh !== 'function') return;
    try {
      fresh = await state.onRefresh(true);
    } catch {
      fresh = null;
    }
    if (state.closed) return;
    if (fresh?.id) state.packet = fresh;
    else stale = true;
    renderResult(state, state.outcome, state.packet, stale);
  }

  /* ---------------------------------- 入口 ---------------------------------- */

  function show(options = {}) {
    closeCard(true);
    const packet = options.packet;
    if (!packet || !packet.id) return null;
    ensureOverlay();
    const node = createNode(packet);
    const state = {
      node,
      entry: options.entry || {},
      packet,
      user: options.user || null,
      viewOnly: options.viewOnly === true,
      // 详情卡片：铺结论视图（进度与领取记录），不以封口视图示人；条目还等着点一下时
      // syncDetailAction 会给它补上「开红包」（v0.13.0）。
      detail: options.detail === true,
      onWrite: options.onWrite,
      onRefresh: options.onRefresh,
      onClose: options.onClose,
      closed: false,
      busy: false,
      joined: Boolean(packet.joined),
      outcome: null,
      error: '',
      timer: null,
      poll: null,
      serverOffset: 0,
      connectionNote: '',
    };
    overlay.append(node);
    overlay.classList.add('active');
    card = state;

    node.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.envelope-close-btn') || target.closest('#lottery-close')) {
        if (!state.busy) closeCard();
      }
    });
    const openButton = node.querySelector('#btn-open-packet');
    if (openButton) openButton.addEventListener('click', (event) => { runWrite(state, event); });
    const joinButton = node.querySelector('#lottery-join');
    if (joinButton) joinButton.addEventListener('click', (event) => { runWrite(state, event); });

    if (P.isLottery(packet)) {
      renderLottery(state);
      if (!lotteryEnded(state)) startPolling(state);
    } else if (state.viewOnly || state.detail) {
      renderResult(state, storedOutcome(state), packet);
    } else {
      renderClosed(state);
    }
    // 面板先用手上的快照把卡片摆出来，只读请求回来后再补进同一张卡片。
    const update = (next = {}) => {
      if (state.closed || state.outcome) return;
      if (next.user !== undefined) state.user = next.user;
      const fresh = next.packet;
      if (fresh?.id && P.isLottery(fresh) !== P.isLottery(state.packet)) {
        // 类型对不上说明节点结构不对（历史快照缺字段），重建一次卡片。
        show({ ...options, packet: fresh });
        return;
      }
      if (fresh?.id) state.packet = fresh;
      if (P.isLottery(state.packet)) {
        renderLottery(state);
        if (!lotteryEnded(state)) startPolling(state);
      } else if (state.viewOnly || state.detail) {
        renderResult(state, storedOutcome(state), state.packet);
      } else {
        renderClosed(state);
      }
    };
    return {
      close: closeCard,
      node,
      packet: () => state.packet,
      isOpen: () => card === state,
      update,
    };
  }

  globalThis.HBEnvelope = { show, close: closeCard, hostId: HOST_ID };

  // 面板一加载就把样式读好，用户点开卡片时就是同步挂载，不会先亮后暗。
  loadStyles();
})();

