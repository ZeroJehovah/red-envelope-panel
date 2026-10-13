/* 弹出面板与常显侧边栏共用的渲染器。
 *
 * 结构与脚本版 browser/userscripts/linuxdo-hongbao-code-sidebar.user.js（v2.35.0）的
 * ensurePanel() 一一对应：头部两个开关（单个/批量、文本/数字）与三个图标按钮（打开红包站、
 * 配置、收起）、可折叠的配置面板（领取方式、动态模式的领取阈值、间隔时间、显示方式、版本号）、
 * 批量文本域、「拆红包」与字数提示、暂停横幅里的「恢复执行」，以及「口令历史（N 条 · 排队 M 条）」
 * 加作废队列/清空历史的图标按钮与逐行（时间、数字标记、点击口令填入输入框、红包详情图标、作废/删除）。
 *
 * 形态差异（记录在 docs/AGENTS.md）：
 *   - 脚本版的悬浮窗口对应点扩展图标弹出的面板，停靠列对应浏览器常显侧边栏；「显示方式」开关在
 *     弹出面板里切到「停靠」会直接打开侧边栏并收起弹出面板；
 *   - 「收起」按钮只在弹出面板出现（侧边栏由浏览器自己收起）；
 *   - 面板不注入页面，脚本版的拖拽与八向缩放没有对应物（窗口由浏览器管）；
 *   - 配置面板的展开状态只活在本次会话，不写进 hb-state-v1。
 */
'use strict';

(function () {
  const api = globalThis.HBApi;
  const P = globalThis.HBProtocol;
  // 口令清洗与校验规则在 code-rules.js，与脚本版逐字符一致。
  const codes = globalThis.HBCodes;
  // 红包详情卡片在独立的详情窗口里渲染（card.html + card.js）；面板这边只负责把窗口叫起来，
  // 卡片尺寸与窗口复用都在 card-window.js（后台自动弹领取卡片时用的是同一份）。
  const cardWindow = globalThis.HBCardWindow;
  const VERSION = api.runtime.getManifest().version;
  const STATE_KEY = 'hb-state-v1';
  // 面板与站点无关：入口只有扩展图标与浏览器侧边栏，红包站只作为登录与核对记录的跳转目标。
  const SITE_URL = 'https://hb.unsnow.org/';
  const SITE_LABEL = 'hb.unsnow.org';

  // 领取方式三选一的文案与悬停说明（配置面板那一行与脚本版同一套说法）。
  const CLAIM_MODE_TEXT = { manual: '古法', direct: '协议', dynamic: '动态' };
  const CLAIM_MODE_HINT = {
    manual: '古法：查到可领的红包后弹卡片，由你点「开红包」',
    direct: '协议：查到可领的红包后台直接领取',
    dynamic: '动态：按领取阈值决定走协议还是古法',
  };

  // 图标全部内联随包（MV3 CSP 不允许远程资源），path 与脚本版同一组。
  const ICON_PATHS = {
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    close: 'M18 6 6 18 M6 6l12 12',
    external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3',
    ban: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M4.93 4.93 19.07 19.07',
    trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M10 11v6 M14 11v6',
  };
  // 红包行图标沿用脚本版的红包字形：两片填充轮廓加一枚封口金。
  const PACKET_ICON_PATHS = [
    'M925.888 76.8v400.96c-57.088 73.408-134.08 130.56-222.848 163.328C681.536 570.112 615.616 518.4 537.6 518.4'
      + 'c-79.936 0-147.264 54.336-166.912 128.064-95.36-31.616-178.048-91.072-238.4-168.704V76.8c0-42.24 34.56-76.8 76.8-76.8'
      + 'h640c42.24 0 76.8 34.56 76.8 76.8z',
    'M925.888 554.56V947.2c0 42.24-34.56 76.8-76.8 76.8h-640c-42.24 0-76.8-34.56-76.8-76.8V554.56c59.712 76.8 141.248'
      + ' 135.808 235.328 167.68C382.208 802.88 452.8 864 537.6 864c87.104 0 159.168-64.448 171.072-148.288'
      + ' 86.464-33.024 161.344-89.344 217.216-161.152z',
    'M659.2 691.2c0 14.976-2.688 29.312-7.68 42.56C634.24 779.904 589.76 812.8 537.6 812.8c-50.496 0-93.824-30.784-112.192-74.688'
      + '-6.08-14.4-9.408-30.272-9.408-46.912 0-10.752 1.408-21.184 4.032-31.104C433.792 608 481.216 569.6 537.6 569.6'
      + 'c55.04 0 101.504 36.544 116.48 86.72 3.328 11.072 5.12 22.784 5.12 34.88z',
  ];

  function icon(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="' + path + '"></path></svg>';
  }

  function packetIcon() {
    return '<svg viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor">'
      + PACKET_ICON_PATHS.map((path, index) => '<path d="' + path + '"'
        + (index === 2 ? ' class="hb-packet-seal"' : '') + '></path>').join('')
      + '</svg>';
  }

  const TEMPLATE = `
    <header class="hb-header">
      <div class="hb-switches">
        <button type="button" class="hb-switch" data-switch="batch" data-on="batch" role="switch" aria-checked="false">
          <span class="hb-switch-option" data-value="single">单个</span>
          <span class="hb-switch-option" data-value="batch">批量</span>
        </button>
        <button type="button" class="hb-switch" data-switch="charset" data-on="numeric" role="switch" aria-checked="false">
          <span class="hb-switch-option" data-value="text">文本</span>
          <span class="hb-switch-option" data-value="numeric">数字</span>
        </button>
      </div>
      <button type="button" class="hb-icon hb-open-site" id="hb-open-site" title="在新标签页打开红包网站" aria-label="在新标签页打开红包网站">${icon(ICON_PATHS.external)}</button>
      <button type="button" class="hb-icon hb-config-toggle" id="hb-config-toggle" title="配置" aria-label="配置" aria-expanded="false">${icon(ICON_PATHS.gear)}</button>
      <button type="button" class="hb-icon hb-close" id="hb-close" title="收起面板" aria-label="收起面板">${icon(ICON_PATHS.close)}</button>
    </header>
    <div class="hb-config" id="hb-config" hidden>
      <div class="hb-config-row">
        <span>领取方式：</span>
        <div class="hb-switch hb-claim-mode" data-switch="claimMode" role="radiogroup" aria-label="领取方式">
          <button type="button" class="hb-switch-option" data-value="manual" role="radio" aria-checked="false">古法</button>
          <button type="button" class="hb-switch-option" data-value="direct" role="radio" aria-checked="false">协议</button>
          <button type="button" class="hb-switch-option" data-value="dynamic" role="radio" aria-checked="false">动态</button>
        </div>
        <span class="hb-config-version" id="hb-config-version"></span>
      </div>
      <div class="hb-config-row hb-config-threshold" id="hb-threshold-row" hidden>
        <span>领取阈值：</span><span>自动协议领取</span>
        <div class="hb-switch" data-switch="claimMetric" role="radiogroup" aria-label="领取阈值的判定量">
          <button type="button" class="hb-switch-option" data-value="total" role="radio" aria-checked="false">总额</button>
          <button type="button" class="hb-switch-option" data-value="average" role="radio" aria-checked="false">人均</button>
        </div>
        <span>达到</span>
        <input id="hb-threshold" class="hb-num" type="number" min="0" step="0.01" inputmode="decimal" aria-label="自动协议领取的金额阈值（LDC，最多两位小数）"><span>的红包</span>
      </div>
      <div class="hb-config-row hb-config-gap-row">
        <span>间隔时间：</span><span>${P.GAP_BASE_MS}+</span>
        <input id="hb-gap" class="hb-num" type="number" min="0" max="${P.GAP_EXTRA_MAX_MS}" step="100" aria-label="基础间隔之上的加时（毫秒）"><span>ms</span>
      </div>
      <div class="hb-config-row">
        <span>显示方式：</span>
        <button type="button" class="hb-switch" data-switch="display" data-on="dock" role="switch" aria-checked="false">
          <span class="hb-switch-option" data-value="float">悬浮</span>
          <span class="hb-switch-option" data-value="dock">停靠</span>
        </button>
      </div>
      <div class="hb-config-row">
        <span>红包站：</span><span class="hb-config-session" id="hb-session-text">状态未确认</span>
        <button type="button" class="hb-mini hb-session" id="hb-session">检查登录</button>
      </div>
    </div>
    <form class="hb-body" id="hb-form">
      <div class="hb-input-row">
        <input id="hb-input" class="hb-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
      <textarea id="hb-textarea" class="hb-input hb-textarea" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" hidden></textarea>
      <div class="hb-submit-row">
        <button type="submit" class="hb-submit" id="hb-submit">拆红包</button>
        <span class="hb-count" id="hb-count">0/18</span>
      </div>
      <div class="hb-paused" id="hb-paused" hidden>
        <span class="hb-paused-text" id="hb-paused-text"></span>
        <button type="button" class="hb-mini hb-resume" id="hb-resume">恢复执行</button>
      </div>
      <div class="hb-history">
        <div class="hb-history-head">
          <span id="hb-history-label"></span>
          <span class="hb-history-actions">
            <button type="button" class="hb-mini hb-void-all" id="hb-void-all" title="作废队列" aria-label="作废队列">${icon(ICON_PATHS.ban)}</button>
            <button type="button" class="hb-mini hb-clear" id="hb-clear" title="清空历史" aria-label="清空历史">${icon(ICON_PATHS.trash)}</button>
          </span>
        </div>
        <div class="hb-list" id="hb-list" tabindex="0"></div>
      </div>
    </form>
  `;

  // 面板只镜像最近一次渲染的 settings 用于输入过滤与开关外观，权威状态始终在后台。
  let settings = {
    charset: 'text', batch: false, claimMode: 'manual', claimMetric: 'total', claimThreshold: 0,
    gapExtraMs: 0, display: 'panel',
  };
  const fieldStates = new WeakMap();
  // 最近一次渲染的完整状态，供「打开卡片」按 id 找条目、以及渲染相对时间；
  // 配置面板的展开状态只活在本次会话。
  let lastState = null;
  let configOpen = false;
  // 单个/批量切换后要把焦点放到换过来的那个输入框，可它此时还藏着的显隐由下一轮渲染决定，
  // 所以先记一笔，等渲染完（输入框换过来、settings 也跟上了）再放。
  let pendingFieldFocus = false;

  // 面板里没有全局提示区（脚本版侧边栏也没有）：领取/参与/查询的结果都写在历史行里，
  // 队列出错走「执行已暂停」横幅，登录检查的结果写在配置面板的「红包站：」一行。
  // 剩下那些没有行级出口的问题（后台不可用、写请求被拒、读不到详情）只落到控制台，
  // 免得在面板里凭空多出一块占地方的提示区。
  function warn(message, error) {
    console.warn('[红包口令面板] ' + message, error ?? '');
  }

  function text(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  }

  /* -------------------------------- 口令输入 -------------------------------- */

  function activeField() {
    return document.getElementById(settings.batch === true ? 'hb-textarea' : 'hb-input');
  }

  function fieldState(field) {
    let entry = fieldStates.get(field);
    if (!entry) {
      entry = { composing: false, justEnded: false };
      fieldStates.set(field, entry);
    }
    return entry;
  }

  function sanitizeFieldValue(field) {
    const oldValue = field.value || '';
    const batch = settings.batch === true;
    const normalized = codes.sanitizeValue(oldValue, batch, settings.charset);
    if (normalized === oldValue) return false;

    const oldCaret = typeof field.selectionStart === 'number' ? field.selectionStart : oldValue.length;
    const normalizedPrefix = codes.sanitizeValue(oldValue.slice(0, oldCaret), batch, settings.charset);
    const caret = Math.min(codes.utf16Length(normalizedPrefix), normalized.length);
    field.value = normalized;
    if (document.activeElement === field && typeof field.setSelectionRange === 'function') {
      field.setSelectionRange(caret, caret);
    }
    return true;
  }

  function handleFieldPaste(event) {
    const field = event.currentTarget;
    if (fieldState(field).composing || !event.clipboardData) return;

    const pastedText = event.clipboardData.getData('text');
    if (pastedText === null || pastedText === undefined) return;

    event.preventDefault();
    const batch = settings.batch === true;
    const value = field.value || '';
    const start = typeof field.selectionStart === 'number' ? field.selectionStart : value.length;
    const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : start;
    // 粘贴分享文案时只留下它携带的口令，其余粘贴仍走下面的普通字符清洗。
    const shared = codes.sharedPasteValue(pastedText, batch, settings.charset);
    const insertion = shared === null ? pastedText : shared;
    const inserted = value.slice(0, start) + insertion + value.slice(end);
    const normalized = codes.sanitizeValue(inserted, batch, settings.charset);
    const normalizedPrefix = codes.sanitizeValue(value.slice(0, start) + insertion, batch, settings.charset);
    const caret = Math.min(codes.utf16Length(normalizedPrefix), normalized.length);

    field.value = normalized;
    if (typeof field.setSelectionRange === 'function') field.setSelectionRange(caret, caret);
    syncDraft();
  }

  function installField(field) {
    // 输入法在输入框里拼字，组字期间不过滤，等上屏后再清洗。
    field.addEventListener('compositionstart', (event) => {
      const current = fieldState(event.currentTarget);
      current.composing = true;
      current.justEnded = false;
    }, true);
    field.addEventListener('compositionend', (event) => {
      const current = fieldState(event.currentTarget);
      current.composing = false;
      current.justEnded = true;
      sanitizeFieldValue(event.currentTarget);
      syncDraft();
    }, true);
    field.addEventListener('input', (event) => {
      const current = fieldState(event.currentTarget);
      if (current.composing || (event.isComposing && !current.justEnded)) {
        current.composing = true;
        return;
      }
      current.justEnded = false;
      sanitizeFieldValue(event.currentTarget);
      syncDraft();
    }, true);
    field.addEventListener('paste', handleFieldPaste, true);
    field.addEventListener('focus', (event) => {
      if (fieldState(event.currentTarget).composing) return;
      if (sanitizeFieldValue(event.currentTarget)) syncDraft();
    }, true);
  }

  // 计数与提交按钮都跟着当前草稿走，所以每条输入路径都汇到这里刷新。
  function syncDraft() {
    const field = activeField();
    const counter = document.getElementById('hb-count');
    const submit = document.getElementById('hb-submit');
    const single = settings.batch !== true && field;
    const list = field ? codes.parseCodes(field.value, settings.charset, settings.batch === true) : [];
    const invalid = list.map((item) => codes.validateCode(item.code, item.charset)).find(Boolean);

    if (counter) {
      counter.hidden = !single;
      counter.textContent = single
        ? Array.from(field.value || '').length + '/' + codes.codeLengthLimit(settings.charset)
        : '';
    }
    if (submit) {
      submit.disabled = !list.length || Boolean(invalid);
      submit.title = invalid || (list.length ? '' : '请先输入口令');
    }
  }

  // 切换模式时把草稿搬过去而不是复制：批量列表保留剩余行，单个输入框保留首行。
  function moveDraftToMode(nextBatch) {
    const input = document.getElementById('hb-input');
    const textarea = document.getElementById('hb-textarea');
    const lines = () => codes.sanitizeValue(textarea.value, true, settings.charset).split('\n').filter(Boolean);

    if (nextBatch) {
      const head = codes.sanitizeValue(input.value, false, settings.charset);
      textarea.value = (head ? [head] : []).concat(lines()).join('\n');
      input.value = '';
    } else {
      const rest = lines();
      input.value = rest.shift() || '';
      textarea.value = rest.join('\n');
    }
  }

  // 只有整条都是数字的草稿能活到数字模式，批量模式逐行判断。
  function applyCharsetToDraft(nextCharset) {
    if (nextCharset !== 'numeric') return;
    const input = document.getElementById('hb-input');
    const textarea = document.getElementById('hb-textarea');
    input.value = codes.keepNumericOnly(input.value);
    textarea.value = textarea.value.split('\n').map(codes.keepNumericOnly).filter(Boolean).join('\n');
  }

  // 点历史里的口令就把它填进当前输入框：单个模式替换草稿，批量模式接在末尾追加一行。
  function fillFromHistory(code) {
    const field = activeField();
    if (!field) return;
    field.value = settings.batch === true
      ? codes.sanitizeValue((field.value.replace(/\s+$/, '') + '\n' + code).replace(/^\n+/, ''), true, settings.charset)
      : codes.sanitizeValue(code, false, settings.charset);
    syncDraft();
    field.focus();
  }

  /* --------------------------------- 头部 ---------------------------------- */

  function setSwitch(name, value) {
    const container = document.querySelector('[data-switch="' + name + '"]');
    if (!container) return;
    // 两段式开关（批量、字符类型、显示方式）把 data-on 那一段算「打开」；三选一的领取
    // 方式与阈值那两段是 role="radiogroup"，每一段自己带 aria-checked，选中谁亮谁。
    const radio = container.getAttribute('role') === 'radiogroup';
    if (!radio) container.setAttribute('aria-checked', String(container.dataset.on === value));
    for (const option of container.querySelectorAll('.hb-switch-option')) {
      const active = option.dataset.value === value;
      option.classList.toggle('is-active', active);
      if (radio) option.setAttribute('aria-checked', String(active));
    }
  }

  function renderHeader(state) {
    settings = { ...settings, ...(state.settings || {}) };
    const batch = settings.batch === true;
    const charset = settings.charset === 'numeric' ? 'numeric' : 'text';
    const input = document.getElementById('hb-input');
    const textarea = document.getElementById('hb-textarea');

    input.hidden = batch;
    textarea.hidden = !batch;
    input.inputMode = charset === 'numeric' ? 'numeric' : 'text';
    textarea.inputMode = input.inputMode;
    input.placeholder = charset === 'numeric' ? '8 位数字（0–9）' : '6–18 位数字、汉字或字母';
    textarea.placeholder = charset === 'numeric'
      ? '每行一个 8 位数字口令'
      : '每行一个 6–18 位数字、汉字或字母口令';

    setSwitch('batch', batch ? 'batch' : 'single');
    setSwitch('charset', charset);
    // 领取方式三选一：古法／协议／动态，认不出来的值一律当古法（与后台的夹紧一致）。
    const claimMode = CLAIM_MODE_TEXT[settings.claimMode] ? settings.claimMode : 'manual';
    setSwitch('claimMode', claimMode);
    setSwitch('claimMetric', settings.claimMetric === 'average' ? 'average' : 'total');
    setSwitch('display', displayMode(settings) === 'dock' ? 'dock' : 'float');

    const batchSwitch = document.querySelector('[data-switch="batch"]');
    const charsetSwitch = document.querySelector('[data-switch="charset"]');
    const displaySwitch = document.querySelector('[data-switch="display"]');
    const claimSwitch = document.querySelector('[data-switch="claimMode"]');
    const metricSwitch = document.querySelector('[data-switch="claimMetric"]');
    batchSwitch.title = batch ? '当前批量模式，点击切换单个' : '当前单个模式，点击切换批量';
    charsetSwitch.title = charset === 'numeric' ? '当前数字模式，点击切换文本' : '当前文本模式，点击切换数字';
    displaySwitch.title = displayMode(settings) === 'dock'
      ? '停靠：点图标开合侧边栏，点击改回悬浮弹窗'
      : '悬浮：点图标弹出面板，点击改为侧边栏常显';
    claimSwitch.title = CLAIM_MODE_HINT[claimMode] + '。对之后提交的口令生效';
    claimSwitch.setAttribute('aria-label', '领取方式：' + CLAIM_MODE_TEXT[claimMode]);
    metricSwitch.title = '人均 = 总额 ÷ 红包个数（抽奖按抽选人数算）';

    syncDraft();
    if (pendingFieldFocus) {
      pendingFieldFocus = false;
      activeField()?.focus();
    }
  }

  // settings.display 存的是 'panel'（点图标弹出）或 'sidebar'（常显侧边栏），界面上叫悬浮/停靠。
  function displayMode(conf) {
    return conf.display === 'sidebar' ? 'dock' : 'float';
  }

  function renderConfig(state) {
    const config = document.getElementById('hb-config');
    const toggle = document.getElementById('hb-config-toggle');
    config.hidden = !configOpen;
    toggle.setAttribute('aria-expanded', String(configOpen));
    // 版本号只从清单读，不在 HTML 里硬编码。
    text('#hb-config-version', 'v' + VERSION);

    const gap = document.getElementById('hb-gap');
    const wanted = String(Number(state.settings?.gapExtraMs) || 0);
    // 正在输入时不要被后台回写的值打断。
    if (gap && document.activeElement !== gap && gap.value !== wanted) gap.value = wanted;

    // 领取阈值那一行只在动态模式下出现（选了动态才需要它）。
    const thresholdRow = document.getElementById('hb-threshold-row');
    if (thresholdRow) thresholdRow.hidden = claimModeOf(state) !== 'dynamic';

    const threshold = document.getElementById('hb-threshold');
    const wantedThreshold = String(P.clampThreshold(state.settings?.claimThreshold));
    if (threshold && document.activeElement !== threshold && threshold.value !== wantedThreshold) {
      threshold.value = wantedThreshold;
    }
  }

  // 配置面板要按「后台那份设置」决定阈值行的显隐；后台还没回话时用面板自己的镜像。
  function claimModeOf(state) {
    const raw = state?.settings?.claimMode ?? settings.claimMode;
    return CLAIM_MODE_TEXT[raw] ? raw : 'manual';
  }

  /* -------------------------------- 历史列表 -------------------------------- */

  function formatTime(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    const pad = (value) => String(value).padStart(2, '0');
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function entryTimeText(entry) {
    if (entry.status === 'queued') {
      if (lastState?.paused === true) return '待执行';
      return entry.scheduledAt ? '预计 ' + formatTime(entry.scheduledAt) : '预计待定';
    }
    if (entry.status === 'awaiting') return '待开启';
    if (entry.status === 'running') return entry.startedAt ? formatTime(entry.startedAt) : '执行中';
    return entry.finishedAt ? formatTime(entry.finishedAt) : '—';
  }

  function entryResultText(entry) {
    if (entry.status === 'queued') return '排队中';
    if (entry.status === 'awaiting') return '等待手动开启';
    if (entry.status === 'running') return '正在查询或领取…';
    return String(entry.result || '') || P.linesText(entry.lines) || '';
  }

  // 行内结果：新版本写的是结构化 lines，旧记录只有一段纯文本，两者走同一条渲染路径。
  function entryLines(entry) {
    if (Array.isArray(entry.lines) && entry.lines.length) return entry.lines;
    const value = entryResultText(entry);
    if (!value) return [];
    if (entry.status === 'queued') return [P.line(value, 'muted')];
    if (/领取成功|已领取/.test(value)) return [P.line(value, 'success')];
    if (/已作废/.test(value)) return [P.line(value, 'muted')];
    if (/^(已停止|未领取|查询失败|未匹配)/.test(value)
      && !/(不存在|找不到|未找到|红包已过期)/.test(value)) return [P.line(value, 'error')];
    return [P.line(value, 'normal')];
  }

  // 一条历史只给一个动作：还能作废的给「作废」（排队中与待开启），已经落定的给「删除」，
  // 正在执行的什么都不给，等回执写回历史再处理。
  function historyAction(entry) {
    if (['queued', 'awaiting'].includes(entry.status)) return 'void';
    return entry.status === 'running' ? '' : 'delete';
  }

  function renderHistory(state) {
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const queued = entries.filter((entry) => entry.status === 'queued').length;
    text('#hb-history-label', '口令历史（' + entries.length + ' 条' + (queued ? ' · 排队 ' + queued + ' 条' : '') + '）');

    const voidAll = document.getElementById('hb-void-all');
    voidAll.disabled = queued === 0;

    const list = document.getElementById('hb-list');
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    // 没有记录就空着（脚本版也是这样），不写占位文案。
    if (!entries.length) return;

    const fragment = document.createDocumentFragment();
    // 新条目在上。
    for (const entry of entries.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'hb-entry';
      row.dataset.status = entry.status;
      row.dataset.id = entry.id;

      const head = document.createElement('div');
      head.className = 'hb-entry-head';
      const time = document.createElement('span');
      time.className = 'hb-entry-time hb-time--' + entry.status;
      time.textContent = entryTimeText(entry);
      head.append(time);
      // 数字口令容易被当成普通文本，只有它带类型标记。
      if (entry.charset === 'numeric') {
        const type = document.createElement('span');
        type.className = 'hb-entry-type';
        type.textContent = '数字';
        head.append(type);
      }
      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'hb-entry-code';
      code.dataset.action = 'fill';
      code.title = '点击把这条口令填入输入框';
      code.textContent = entry.code;
      head.append(code);
      if (P.hasMatchedPacket(entry)) {
        const packetButton = document.createElement('button');
        packetButton.type = 'button';
        packetButton.className = 'hb-entry-packet';
        packetButton.dataset.action = 'open';
        packetButton.title = '查看红包详情';
        packetButton.setAttribute('aria-label', '查看 ' + entry.code + ' 的红包详情');
        packetButton.innerHTML = packetIcon();
        head.append(packetButton);
      }
      const rowAction = historyAction(entry);
      if (rowAction) {
        const actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.className = rowAction === 'void' ? 'hb-entry-void' : 'hb-entry-delete';
        actionButton.dataset.action = rowAction;
        actionButton.textContent = rowAction === 'void' ? '作废' : '删除';
        actionButton.title = rowAction === 'void' ? '作废这条口令' : '从历史中删除这条口令';
        head.append(actionButton);
      }
      row.append(head);

      const result = document.createElement('div');
      result.className = 'hb-entry-result';
      for (const item of entryLines(entry)) {
        const line = document.createElement('div');
        line.className = 'hb-entry-line';
        line.dataset.tone = item.tone || 'normal';
        line.textContent = String(item.text ?? '');
        result.append(line);
      }
      row.append(result);
      fragment.append(row);
    }
    list.append(fragment);
    list.scrollTop = scrollTop;
  }

  function renderPaused(state) {
    const banner = document.getElementById('hb-paused');
    if (!banner) return;
    const paused = state.paused === true;
    banner.hidden = !paused;
    if (paused) text('#hb-paused-text', '执行已暂停：' + (state.pausedReason || '执行报错'));
  }

  /* --------------------------------- 写入 ---------------------------------- */

  // 所有动作都经这里转给后台。结果不在这里提示：写操作的结果由后勤写回历史行，
  // 真正失败（消息发不出去或被后台拒绝）只记一笔控制台。
  function send(message) {
    return api.runtime.sendMessage(message).then((response) => {
      if (!response?.ok) warn(message.type + ' 被后台拒绝：' + (response?.error || '未知错误'));
      return response;
    }, (error) => {
      warn(message.type + ' 发不出去：后台暂不可用', error);
      return undefined;
    });
  }

  // 保存设置：先本地镜像并立即刷新开关外观，再写后台；
  // 后台状态回来后还会经 storage.onChanged 重渲染一次，因此这里不等回环。
  async function patchSettings(patch) {
    settings = { ...settings, ...patch };
    renderHeader(lastState || { settings });
    renderConfig(lastState || { settings });
    await send({ type: 'hb:state:patch', patch: { settings: patch } });
  }

  async function submitDraft() {
    const field = activeField();
    const list = field ? codes.parseCodes(field.value, settings.charset, settings.batch === true) : [];
    // 空草稿与非法的口令在按钮上就拦住了（禁用 + title 说明），这里只是兜底。
    if (!list.length) return;
    const invalid = list.map((item) => codes.validateCode(item.code, item.charset)).find(Boolean);
    if (invalid) {
      warn('口令未通过校验，未提交：' + invalid);
      return;
    }
    const response = await send({ type: 'hb:submit', codes: list, claimMode: settings.claimMode });
    if (!response?.ok) return;
    // 入队成功后清空草稿；新口令会立刻以「排队中」出现在历史列表里，不再另写提示。
    if (field) field.value = '';
    syncDraft();
  }

  /* ------------------------------ 红包详情窗口 ------------------------------ */

  // 打开红包详情：卡片在独立窗口里渲染——弹出面板受浏览器弹窗高度上限（600px）限制，
  // 卡片按原尺寸（384×624、抽奖 504×768）会被压扁。
  //
  // 「待开启 + 古法」的条目开的还是**领取卡片**（脚本版里那张还摆在页面上、等着点一下的卡
  // 片）：关掉卡片不改条目状态，条目仍是待开启，所以历史行得留一条回到那张卡片的路——后台只在
  // 「这一次刚查到可领」时弹卡，唤醒不再补弹（v0.11.1），这条路就是它。其余条目（已领取、已开
  // 奖、等开奖的抽奖……）一律只读详情卡片，与脚本版 openHistoryPacket 同一副只读视图，从不给
  // 历史卡片挂开启按钮。两种卡片各占一个窗口，互不顶掉。
  async function openEnvelopeWindow(id) {
    const entry = (lastState?.entries || []).find((item) => item.id === id);
    if (!entry?.packet?.id) {
      warn('这条记录没有红包详情可看：' + id);
      return;
    }
    if (!cardWindow) {
      warn('红包详情窗口脚本未加载，请重新打开面板。');
      return;
    }
    const view = cardWindow.claimable(entry) ? 'claim' : 'detail';
    const result = await cardWindow.open({ id, entry, packet: entry.packet, view });
    if (result.ok !== true) warn('打开红包详情窗口失败：' + result.error);
  }

  /* -------------------------------- 侧边栏 --------------------------------- */

  // chrome.sidePanel.open 必须在用户手势内发起，而 await 会打断手势，
  // 因此在面板初始化时先取窗口 ID，点击时同步调用。
  let currentWindowId = null;

  async function rememberWindowId() {
    try {
      currentWindowId = (await api.windows.getCurrent()).id ?? null;
    } catch {
      currentWindowId = null;
    }
  }

  function openSidebar() {
    if (!api.sidePanel?.open) {
      warn('当前浏览器不支持扩展侧边栏，请使用 Chrome 116 及以上版本。');
      return;
    }
    if (currentWindowId === null) {
      warn('尚未确认当前窗口，无法打开侧边栏。');
      return;
    }
    api.sidePanel.open({ windowId: currentWindowId }).then(() => {
      window.close();
    }, (error) => {
      warn('打开侧边栏失败', error);
    });
  }

  /* --------------------------------- 入口 ---------------------------------- */

  function mount(root, options = {}) {
    // 悬浮（弹出面板）是默认形态；侧边栏外壳传 shell: 'sidebar'。
    const shell = options.shell || (options.allowSidePanelOpen === false ? 'sidebar' : 'popup');
    const isPopup = shell === 'popup';

    root.innerHTML = TEMPLATE;

    document.getElementById('hb-open-site').addEventListener('click', () => {
      api.tabs.create({ url: SITE_URL });
    });
    document.getElementById('hb-config-toggle').addEventListener('click', () => {
      configOpen = !configOpen;
      renderConfig(lastState || { settings });
    });
    // 收起 = 关掉弹出面板；侧边栏由浏览器自己收起，所以那里不出现这个按钮。
    const closeButton = document.getElementById('hb-close');
    if (isPopup) {
      closeButton.addEventListener('click', () => window.close());
    } else {
      closeButton.hidden = true;
    }

    document.querySelector('[data-switch="batch"]').addEventListener('click', () => {
      const next = settings.batch !== true;
      moveDraftToMode(next);
      patchSettings({ batch: next });
      pendingFieldFocus = true;
    });
    document.querySelector('[data-switch="charset"]').addEventListener('click', () => {
      const next = settings.charset === 'numeric' ? 'text' : 'numeric';
      applyCharsetToDraft(next);
      patchSettings({ charset: next });
      activeField()?.focus();
    });
    // 三选一：点哪一段就是哪一段。
    document.querySelector('[data-switch="claimMode"]').addEventListener('click', (event) => {
      const option = event.target.closest('.hb-switch-option');
      if (!option) return;
      // 领取方式存进设置，新的口令按它走；脚本版也只是切换开关，不另写说明。
      patchSettings({ claimMode: option.dataset.value });
    });
    document.querySelector('[data-switch="claimMetric"]').addEventListener('click', (event) => {
      const option = event.target.closest('.hb-switch-option');
      if (!option) return;
      patchSettings({ claimMetric: option.dataset.value });
    });
    document.querySelector('[data-switch="display"]').addEventListener('click', () => {
      const next = displayMode(settings) === 'dock' ? 'float' : 'dock';
      // 显示方式是用户的选择，写下来就行：后台按它决定点图标是开合侧边栏还是弹面板。
      // 这里顺带把眼前的形态也换成选的那个。
      patchSettings({ display: next === 'dock' ? 'sidebar' : 'panel' });
      if (next === 'dock') {
        // 切到停靠：弹出面板里直接拉起侧边栏并收起自己（图标点击从此刻起交给侧边栏）。
        if (isPopup) {
          openSidebar();
        }
        return;
      }
      // 切回悬浮：常显侧边栏把自己收起来（收不掉也不改设置——选择是用户的，形态只是外壳）。
      if (!isPopup) {
        window.close();
      }
    });

    const gapInput = document.getElementById('hb-gap');
    // 输入时即时生效，失焦或回车后再把夹紧后的值写回控件。
    gapInput.addEventListener('input', () => {
      patchSettings({ gapExtraMs: P.clampGapExtra(gapInput.value) });
    });
    gapInput.addEventListener('change', () => {
      patchSettings({ gapExtraMs: P.clampGapExtra(gapInput.value) });
      gapInput.value = String(P.clampGapExtra(gapInput.value));
    });

    const thresholdInput = document.getElementById('hb-threshold');
    // 阈值的写法与间隔时间同一套路子：输入即时生效，失焦再按两位小数写回控件。
    thresholdInput.addEventListener('input', () => {
      patchSettings({ claimThreshold: P.clampThreshold(thresholdInput.value) });
    });
    thresholdInput.addEventListener('change', () => {
      const value = P.clampThreshold(thresholdInput.value);
      patchSettings({ claimThreshold: value });
      thresholdInput.value = String(value);
    });

    document.getElementById('hb-session').addEventListener('click', async () => {
      // 登录状态就写在配置面板「红包站：」那一行里，不再占用面板底部。
      text('#hb-session-text', '正在确认…');
      const response = await send({ type: 'hb:session' });
      if (!response) {
        text('#hb-session-text', '检查失败');
        return;
      }
      if (!response.ok) {
        text('#hb-session-text', '检查失败：' + (response.error || '未知错误'));
        return;
      }
      text('#hb-session-text', response.loggedIn
        ? '已登录：' + response.username
        : '未登录，请到 ' + SITE_LABEL + ' 登录');
    });

    document.getElementById('hb-resume').addEventListener('click', () => send({ type: 'hb:resume' }));
    document.getElementById('hb-void-all').addEventListener('click', () => send({ type: 'hb:void-all' }));
    document.getElementById('hb-clear').addEventListener('click', () => send({ type: 'hb:clear' }));

    // 历史行的动作走事件委托：行元素每次渲染都会重建。
    document.getElementById('hb-list').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const row = button.closest('.hb-entry');
      const id = row?.dataset.id;
      if (!id) return;
      const action = button.dataset.action;
      if (action === 'fill') {
        fillFromHistory(button.textContent);
        return;
      }
      button.disabled = true;
      // 开详情窗口只是把窗口叫起来；真正的领取/参与在卡片里由真实点击触发。
      if (action === 'open') {
        openEnvelopeWindow(id).finally(() => { button.disabled = false; });
        return;
      }
      const message = action === 'void' ? { type: 'hb:void', id } : { type: 'hb:delete', id };
      send(message).then((response) => {
        if (!response?.ok) button.disabled = false;
      });
    });

    const form = document.getElementById('hb-form');
    installField(document.getElementById('hb-input'));
    installField(document.getElementById('hb-textarea'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitDraft();
    });

    if (isPopup) {
      rememberWindowId();
    }
    // v0.10.0 起「显示方式」是用户的选择，而不是当前形态的镜像：停靠＝点图标去开合侧边栏
    // （图标点击交给浏览器接管），悬浮＝点图标弹面板。所以侧边栏这边**不再**在挂载或收起时
    // 改写它——手动把侧边栏关掉不该改掉这个选择，下次点图标还是它。

    // 打开就把焦点放进输入框（弹出面板与常显侧边栏一样），省掉一次点击。两个外壳的交焦点时序
    // 不一样：弹出面板一打开就是自己的窗口，焦点说到就到；侧边栏是 Chrome 把面板挂进窗口右侧
    // 之后才交焦点，有时还先落在面板里别的元素（甚至空的 body）上。所以这里不是放一次就算——
    // 刚挂载时补几次，面板重新露出来（visibilitychange）或窗口拿到焦点时也补一次。用户在面板
    // 里动过键盘鼠标（焦点是他自己选的）之后就不再插手，直到面板被收起来再打开。
    let userTouched = false;
    const noteTouch = () => { userTouched = true; };
    document.addEventListener('pointerdown', noteTouch, true);
    document.addEventListener('keydown', noteTouch, true);

    let focusing = false;
    const focusField = () => {
      if (focusing) return false;
      const field = activeField();
      if (!field) return false;
      if (document.activeElement === field) return true;
      // 用户自己点过/按过键之后就不再插手（刚打开时他会点哪儿？——点进来编辑别的控件），
      // 那时焦点是他选的；面板重新露出来时会把这个记录清掉，重新按「刚打开」处理。
      if (userTouched) return false;
      // window.focus() 可能同步抛出 focus 事件再回到这里，加一道闸免得兜圈。
      focusing = true;
      try {
        // 侧边栏那边文档未必已经拿到焦点，先向窗口要一次；不接受也不报错，focus() 仍会记账。
        window.focus();
        field.focus();
      } catch { /* 忽略：侧边栏不接受 window.focus */ } finally {
        focusing = false;
      }
      return document.activeElement === field;
    };

    // 第一次渲染回来才知道用户是单个还是批量，所以 refresh 结束时放第一次；侧边栏的交焦点比
    // 页面加载晚，再补几次把这个窗口期盖住。
    const focusRetries = [];
    for (const delay of [60, 200, 450, 900, 1600]) {
      focusRetries.push(setTimeout(() => {
        if (focusField()) focusRetries.forEach((timer) => clearTimeout(timer));
      }, delay));
    }
    // 侧边栏被藏起来再露出来时页面不会重新加载，这一跳就是「又被打开了一次」：不管上回焦点
    // 落在哪儿都把光标放回输入框，同时清掉「用户动过」的记录。
    document.addEventListener('visibilitychange', () => {
      userTouched = false;
      if (document.visibilityState === 'visible') focusField();
    });
    // 侧边栏那边的焦点是 Chrome 晚一步交过来的，窗口真正拿到焦点时再确认一次。
    window.addEventListener('focus', () => { focusField(); });

    const refresh = async () => {
      try {
        const response = await api.runtime.sendMessage({ type: 'hb:state:get' });
        render(response?.ok ? response.state : { entries: [], settings: {} });
        if (!response?.ok) warn('读取状态失败：' + (response?.error || '未知错误'));
      } catch (error) {
        render({ entries: [], settings: {} });
        warn('后台暂不可用，面板显示为空状态', error);
      }
    };

    // 面板与后台共享同一份 chrome.storage.local 状态，直接订阅变更，不再自己做副本。
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STATE_KEY]) refresh();
    });

    refresh().finally(focusField);
    return { refresh };
  }

  function render(state) {
    lastState = state;
    renderHeader(state);
    renderConfig(state);
    renderPaused(state);
    renderHistory(state);
  }

  globalThis.HBPanel = { mount };
})();

