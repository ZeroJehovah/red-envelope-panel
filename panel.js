/* 弹出面板与常显侧边栏共用的渲染器。
 *
 * 两个外壳只提供不同的 <body> 尺寸类，渲染、输入、状态订阅与入口按钮都在这里，
 * 避免两套面板各写一遍。口令清洗与校验规则在 code-rules.js（移植自脚本版）。
 */
'use strict';

(function () {
  const api = globalThis.HBApi;
  const VERSION = api.runtime.getManifest().version;
  const STATE_KEY = 'hb-state-v1';
  // 面板与站点无关：入口只有扩展图标与浏览器侧边栏，红包站只作为登录与核对记录的跳转目标。
  const SITE_URL = 'https://hb.unsnow.org/';
  const SITE_LABEL = 'hb.unsnow.org';

  const STATUS_LABEL = {
    queued: '排队中',
    awaiting: '待开启',
    running: '执行中',
    done: '已完成',
    failed: '失败',
    void: '已作废',
  };
  const STATUS_CLASS = {
    queued: 'hb-status--idle',
    awaiting: 'hb-status--gold',
    running: 'hb-status--gold',
    done: 'hb-status--green',
    failed: 'hb-status--red',
    void: 'hb-status--muted',
  };
  const CLAIM_MODE_LABEL = { manual: '古法（手动开启）', direct: '协议（直接领取）' };
  const CHARSET_LABEL = { text: '文本口令', numeric: '数字口令' };

  // 口令规则来自 code-rules.js，与脚本版逐字符一致。
  const codes = globalThis.HBCodes;
  // 面板只镜像最近一次渲染的 settings 用于输入过滤，权威状态始终在后台；写入一律走消息接口。
  let settings = { charset: 'text', batch: false, claimMode: 'manual', gapExtraMs: 0 };
  const fieldStates = new WeakMap();

  const TEMPLATE = `
    <header class="hb-header">
      <div class="hb-heading">
        <h1 class="hb-title">红包口令面板</h1>
        <span class="hb-subtitle">红包口令</span>
      </div>
      <span class="hb-version" id="hb-version"></span>
    </header>
    <form class="hb-card hb-input-card" id="hb-form">
      <div class="hb-input-head">
        <button type="button" class="hb-switch" data-switch="batch" role="switch" aria-checked="false">
          <span class="hb-switch-option" data-value="single">单个</span>
          <span class="hb-switch-option" data-value="batch">批量</span>
        </button>
        <button type="button" class="hb-switch" data-switch="charset" role="switch" aria-checked="false">
          <span class="hb-switch-option" data-value="text">文本</span>
          <span class="hb-switch-option" data-value="numeric">数字</span>
        </button>
      </div>
      <input id="hb-input" class="hb-field" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
      <textarea id="hb-textarea" class="hb-field hb-field--batch" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" hidden></textarea>
      <div class="hb-submit-row">
        <button type="submit" class="hb-button hb-button--primary hb-submit" id="hb-submit">拆红包</button>
        <span class="hb-count" id="hb-count">0/18</span>
      </div>
    </form>
    <section class="hb-card" id="hb-queue">
      <div class="hb-stats">
        <span class="hb-stat"><b id="hb-count-entries">0</b> 条口令</span>
        <span class="hb-stat"><b id="hb-count-waiting">0</b> 等待中</span>
        <span class="hb-stat"><b id="hb-count-done">0</b> 已完成</span>
      </div>
      <p class="hb-paused" id="hb-paused" hidden></p>
      <ul class="hb-list" id="hb-list"></ul>
      <p class="hb-empty" id="hb-empty">队列为空，输入口令后点「拆红包」。</p>
      <div class="hb-queue-actions">
        <button type="button" class="hb-row-button" id="hb-resume" hidden>继续队列</button>
        <button type="button" class="hb-row-button" id="hb-void-all" hidden>全部作废</button>
        <button type="button" class="hb-row-button" id="hb-clear" hidden>清空历史</button>
      </div>
    </section>
    <section class="hb-card hb-meta" id="hb-meta"></section>
    <section class="hb-actions">
      <button type="button" class="hb-button" id="hb-session">检查登录</button>
      <button type="button" class="hb-button hb-button--primary" id="hb-open-sidebar" hidden>在侧边栏常显</button>
      <button type="button" class="hb-button" id="hb-open-site"></button>
    </section>
    <p class="hb-hint" id="hb-hint"></p>
  `;

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

    counter.hidden = !single;
    counter.textContent = single
      ? Array.from(field.value || '').length + '/' + codes.codeLengthLimit(settings.charset)
      : '';
    submit.disabled = !list.length || Boolean(invalid);
    submit.title = invalid || (list.length ? '' : '请先输入口令');
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

  function renderInput(state) {
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
    textarea.placeholder = charset === 'numeric' ? '每行一个 8 位数字口令' : '每行一个 6–18 位数字、汉字或字母口令';

    const batchSwitch = document.querySelector('[data-switch="batch"]');
    const charsetSwitch = document.querySelector('[data-switch="charset"]');
    batchSwitch.setAttribute('aria-checked', String(batch));
    charsetSwitch.setAttribute('aria-checked', String(charset === 'numeric'));
    for (const option of batchSwitch.querySelectorAll('.hb-switch-option')) {
      option.classList.toggle('is-active', option.dataset.value === (batch ? 'batch' : 'single'));
    }
    for (const option of charsetSwitch.querySelectorAll('.hb-switch-option')) {
      option.classList.toggle('is-active', option.dataset.value === charset);
    }
    syncDraft();
  }

  // 保存设置：先本地镜像并立即刷新开关外观，再写后台；
  // 后台状态回来后还会经 storage.onChanged 重渲染一次，因此这里不等回环。
  async function patchSettings(patch, hint) {
    settings = { ...settings, ...patch };
    renderInput({ settings });
    try {
      const response = await api.runtime.sendMessage({ type: 'hb:state:patch', patch: { settings: patch } });
      if (!response?.ok) hint.textContent = '保存设置失败：' + (response?.error || '未知错误');
    } catch (error) {
      hint.textContent = '后台暂不可用：' + String(error?.message || error);
    }
  }

  async function submitDraft(hint) {
    const field = activeField();
    const list = field ? codes.parseCodes(field.value, settings.charset, settings.batch === true) : [];
    if (!list.length) {
      hint.textContent = '请先输入口令。';
      return;
    }
    const invalid = list.map((item) => codes.validateCode(item.code, item.charset)).find(Boolean);
    if (invalid) {
      hint.textContent = invalid;
      return;
    }
    try {
      const response = await api.runtime.sendMessage({
        type: 'hb:submit',
        codes: list,
        claimMode: settings.claimMode,
      });
      if (!response?.ok) {
        hint.textContent = '提交未完成：' + (response?.error || '未知错误');
        return;
      }
      // 入队成功后清空草稿，队列状态由 storage 变更推回面板。
      if (field) field.value = '';
      syncDraft();
      hint.textContent = '已加入队列 ' + response.added + ' 条口令。';
    } catch (error) {
      hint.textContent = '后台暂不可用：' + String(error?.message || error);
    }
  }

  function renderMeta(state) {
    const meta = document.getElementById('hb-meta');
    const conf = state.settings || {};
    const rows = [
      ['输入模式', conf.batch ? '批量（每行一条）' : '单个'],
      ['口令类型', CHARSET_LABEL[conf.charset] || CHARSET_LABEL.text],
      ['请求间隔', (5 + Math.max(0, Number(conf.gapExtraMs) || 0) / 1000).toFixed(1) + ' 秒起'],
    ];
    const nodes = rows.map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'hb-meta-row';
      const key = document.createElement('span');
      key.className = 'hb-meta-label';
      key.textContent = label;
      const val = document.createElement('span');
      val.className = 'hb-meta-value';
      val.textContent = value;
      row.append(key, val);
      return row;
    });

    // 领取方式可切换：古法停在等待点击，协议由后台直接领取。
    const modeRow = document.createElement('div');
    modeRow.className = 'hb-meta-row';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'hb-meta-label';
    modeLabel.textContent = '领取方式';
    const switcher = document.createElement('div');
    switcher.className = 'hb-switch';
    switcher.dataset.switch = 'claimMode';
    switcher.setAttribute('role', 'switch');
    switcher.setAttribute('aria-checked', String(settings.claimMode === 'direct'));
    switcher.title = CLAIM_MODE_LABEL[settings.claimMode] || CLAIM_MODE_LABEL.manual;
    for (const [value, label] of [['manual', '古法'], ['direct', '协议']]) {
      const option = document.createElement('span');
      option.className = 'hb-switch-option' + (settings.claimMode === value ? ' is-active' : '');
      option.dataset.value = value;
      option.textContent = label;
      switcher.append(option);
    }
    modeRow.append(modeLabel, switcher);
    nodes.push(modeRow);
    meta.replaceChildren(...nodes);
  }

  const TONE_CLASS = { normal: 'hb-line--normal', success: 'hb-line--success', error: 'hb-line--error', muted: 'hb-line--muted' };

  function stampText(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    const pad = (value) => String(value).padStart(2, '0');
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  // 报名过的抽奖在等开奖，页面侧不再给写入动作。
  function statusLabel(entry) {
    if (entry.status === 'awaiting' && entry.packet?.joined) return '等待开奖';
    return STATUS_LABEL[entry.status] || '未知';
  }

  // 一条历史能给的动作：等待点击的开启/参与抽选、排队中的作废、已完结的删除；
  // 执行中不给动作，抽奖报名后也不再给动作。
  function actionFor(entry) {
    if (entry.status === 'awaiting' && entry.packet?.joined) return { action: 'delete', label: '删除' };
    if (entry.status === 'awaiting' && entry.claimMode === 'manual') {
      return { action: 'claim', label: entry.packet?.type === 'lottery' ? '参与抽选' : '开红包', primary: true };
    }
    if (entry.status === 'queued') return { action: 'void', label: '作废' };
    if (entry.status === 'running') return null;
    return { action: 'delete', label: '删除' };
  }

  function renderQueue(state) {
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const waiting = entries.filter((entry) => ['queued', 'awaiting', 'running'].includes(entry.status)).length;
    const done = entries.filter((entry) => entry.status === 'done').length;
    text('#hb-count-entries', String(entries.length));
    text('#hb-count-waiting', String(waiting));
    text('#hb-count-done', String(done));

    const paused = state.paused === true;
    const pausedNode = document.getElementById('hb-paused');
    pausedNode.hidden = !paused;
    pausedNode.textContent = paused ? '队列已暂停：' + (state.pausedReason || '上一条未成功，请核对后继续。') : '';

    const list = document.getElementById('hb-list');
    // 新条目在上；口令与结果都是外部输入，只作为文本节点写入。
    const ordered = entries.slice().reverse();
    list.replaceChildren(...ordered.map((entry) => {
      const item = document.createElement('li');
      item.className = 'hb-row';
      item.dataset.id = entry.id;

      const head = document.createElement('div');
      head.className = 'hb-row-head';
      const code = document.createElement('code');
      code.className = 'hb-code';
      code.textContent = String(entry.code || '（无口令）');
      const status = document.createElement('span');
      status.className = 'hb-status ' + (STATUS_CLASS[entry.status] || 'hb-status--idle');
      status.textContent = statusLabel(entry);
      head.append(code, status);
      item.append(head);

      const lines = Array.isArray(entry.lines) ? entry.lines : [];
      const resultText = lines.length ? '' : String(entry.result || '');
      if (lines.length || resultText) {
        const result = document.createElement('p');
        result.className = 'hb-row-result';
        const items = lines.length
          ? lines.map((line) => ({ text: line.text, tone: line.tone }))
          : [{ text: resultText, tone: 'muted' }];
        result.append(...items.map(({ text: content, tone }) => {
          const span = document.createElement('span');
          span.className = 'hb-line ' + (TONE_CLASS[tone] || TONE_CLASS.normal);
          span.textContent = String(content);
          return span;
        }));
        item.append(result);
      }

      const foot = document.createElement('div');
      foot.className = 'hb-row-head';
      const time = document.createElement('span');
      time.className = 'hb-row-time';
      time.textContent = stampText(entry.createdAt);
      foot.append(time);
      const action = actionFor(entry);
      if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hb-row-button' + (action.primary ? ' hb-row-button--primary' : '');
        button.dataset.action = action.action;
        button.textContent = action.label;
        foot.append(button);
      }
      item.append(foot);
      return item;
    }));

    list.hidden = ordered.length === 0;
    const empty = document.getElementById('hb-empty');
    empty.hidden = ordered.length > 0;
    empty.textContent = '队列为空，输入口令后点「拆红包」。';

    document.getElementById('hb-resume').hidden = !paused;
    document.getElementById('hb-void-all').hidden = !entries.some((entry) => entry.status === 'queued');
    document.getElementById('hb-clear').hidden = ordered.length === 0;
  }

  function render(state) {
    renderInput(state);
    renderQueue(state);
    renderMeta(state);
  }

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

  function openSidebar(hint) {
    if (!api.sidePanel?.open) {
      hint.textContent = '当前浏览器不支持扩展侧边栏，请使用 Chrome 116 及以上版本。';
      return;
    }
    if (currentWindowId === null) {
      hint.textContent = '尚未确认当前窗口，请在弹出面板中重试。';
      return;
    }
    api.sidePanel.open({ windowId: currentWindowId }).then(() => {
      window.close();
    }, (error) => {
      hint.textContent = '打开侧边栏失败：' + String(error?.message || error);
    });
  }

  function mount(root, options = {}) {
    root.innerHTML = TEMPLATE;
    text('#hb-version', 'v' + VERSION);

    const hint = document.getElementById('hb-hint');
    const sidebarButton = document.getElementById('hb-open-sidebar');
    if (options.allowSidePanelOpen) {
      sidebarButton.hidden = false;
      sidebarButton.addEventListener('click', () => openSidebar(hint));
      rememberWindowId();
      hint.textContent = '面板在任意网站都可用；关闭面板不影响后台队列。';
    }
    if (!options.allowSidePanelOpen) {
      hint.textContent = '面板固定在浏览器侧边栏，可在侧边栏菜单中调整位置；关闭侧边栏不影响后台队列。';
    }

    const siteButton = document.getElementById('hb-open-site');
    siteButton.textContent = '打开 ' + SITE_LABEL;
    siteButton.addEventListener('click', () => {
      api.tabs.create({ url: SITE_URL });
    });

    const send = (message, okText) => api.runtime.sendMessage(message).then((response) => {
      hint.textContent = response?.ok ? (okText || '') : (response?.error || '操作未完成');
      return response;
    }, (error) => {
      hint.textContent = '后台暂不可用：' + String(error?.message || error);
      return undefined;
    });

    // 队列动作都交给后台：面板只发消息，状态经 storage 变更回流后重绘。
    document.getElementById('hb-resume').addEventListener('click', () => send({ type: 'hb:resume' }, ''));
    document.getElementById('hb-void-all').addEventListener('click', () => send({ type: 'hb:void-all' }, ''));
    document.getElementById('hb-clear').addEventListener('click', () => send({ type: 'hb:clear' }, ''));

    document.getElementById('hb-session').addEventListener('click', async () => {
      hint.textContent = '正在确认红包站登录状态…';
      const response = await send({ type: 'hb:session' }, '');
      if (!response?.ok) return;
      hint.textContent = response.loggedIn
        ? '已登录红包站：' + response.username
        : '未检测到红包站登录状态，请打开 ' + SITE_LABEL + ' 登录后再试。';
    });

    document.getElementById('hb-meta').addEventListener('click', (event) => {
      if (!event.target.closest('[data-switch="claimMode"]')) return;
      const next = settings.claimMode === 'direct' ? 'manual' : 'direct';
      patchSettings({ claimMode: next }, hint);
      hint.textContent = next === 'direct'
        ? '新的口令会由后台直接领取。'
        : '新的口令会停在「待开启」，由你在面板上点击开启。';
    });

    // 历史行的动作走事件委托：行元素每次渲染都会重建。
    document.getElementById('hb-list').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.closest('.hb-row')?.dataset.id;
      if (!id) return;
      const action = button.dataset.action;
      // 领取是写操作：只认真实点击（后台还会校验条目状态），一次点击只放行一条请求。
      if (action === 'claim' && !event.isTrusted) return;
      const message = action === 'claim'
        ? { type: 'hb:claim', id, trusted: true }
        : (action === 'void' ? { type: 'hb:void', id } : { type: 'hb:delete', id });
      button.disabled = true;
      send(message, action === 'claim' ? '领取请求已发出，结果以红包站为准。' : '').then((response) => {
        if (!response?.ok) button.disabled = false;
      });
    });

    const form = document.getElementById('hb-form');
    installField(document.getElementById('hb-input'));
    installField(document.getElementById('hb-textarea'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitDraft(hint);
    });
    document.querySelector('[data-switch="batch"]').addEventListener('click', () => {
      const next = settings.batch !== true;
      moveDraftToMode(next);
      patchSettings({ batch: next }, hint);
      activeField()?.focus();
    });
    document.querySelector('[data-switch="charset"]').addEventListener('click', () => {
      const next = settings.charset === 'numeric' ? 'text' : 'numeric';
      applyCharsetToDraft(next);
      patchSettings({ charset: next }, hint);
      activeField()?.focus();
    });
    syncDraft();

    const refresh = async () => {
      try {
        const response = await api.runtime.sendMessage({ type: 'hb:state:get' });
        render(response?.ok ? response.state : { entries: [], settings: {} });
        if (!response?.ok) hint.textContent = '读取状态失败：' + (response?.error || '未知错误');
      } catch (error) {
        render({ entries: [], settings: {} });
        hint.textContent = '后台暂不可用：' + String(error?.message || error);
      }
    };

    // 面板与内容脚本共享同一份 chrome.storage.local 状态，直接订阅变更，不再自己做副本。
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STATE_KEY]) refresh();
    });

    refresh();
    return { refresh };
  }

  globalThis.HBPanel = { mount };
})();
