/* 弹出面板与常显侧边栏共用的渲染器。
 *
 * 两个外壳只提供不同的 <body> 尺寸类，渲染、状态订阅与入口按钮都在这里，
 * 避免两套面板各写一遍。里程碑 2 起在这里接入口令输入、队列与历史列表。
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

  const TEMPLATE = `
    <header class="hb-header">
      <div class="hb-heading">
        <h1 class="hb-title">红包口令面板</h1>
        <span class="hb-subtitle">红包口令</span>
      </div>
      <span class="hb-version" id="hb-version"></span>
    </header>
    <section class="hb-card">
      <div class="hb-stats">
        <span class="hb-stat"><b id="hb-count-entries">0</b> 条口令</span>
        <span class="hb-stat"><b id="hb-count-waiting">0</b> 等待中</span>
        <span class="hb-stat"><b id="hb-count-done">0</b> 已完成</span>
      </div>
      <ul class="hb-list" id="hb-list"></ul>
      <p class="hb-empty" id="hb-empty">尚未接入口令提交，队列为空。</p>
    </section>
    <section class="hb-card hb-meta" id="hb-meta"></section>
    <section class="hb-actions">
      <button type="button" class="hb-button hb-button--primary" id="hb-open-sidebar" hidden>在侧边栏常显</button>
      <button type="button" class="hb-button" id="hb-open-site"></button>
    </section>
    <p class="hb-hint" id="hb-hint"></p>
  `;

  function text(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  }

  function renderMeta(state) {
    const meta = document.getElementById('hb-meta');
    const settings = state.settings || {};
    const rows = [
      ['输入模式', settings.batch ? '批量（每行一条）' : '单个'],
      ['口令类型', CHARSET_LABEL[settings.charset] || CHARSET_LABEL.text],
      ['领取方式', CLAIM_MODE_LABEL[settings.claimMode] || CLAIM_MODE_LABEL.manual],
      ['请求间隔', (5 + Math.max(0, Number(settings.gapExtraMs) || 0) / 1000).toFixed(1) + ' 秒起'],
    ];
    meta.replaceChildren(...rows.map(([label, value]) => {
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
    }));
  }

  function renderList(state) {
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const waiting = entries.filter((entry) => entry.status !== 'done' && entry.status !== 'failed' && entry.status !== 'void').length;
    const done = entries.filter((entry) => entry.status === 'done').length;
    text('#hb-count-entries', String(entries.length));
    text('#hb-count-waiting', String(waiting));
    text('#hb-count-done', String(done));

    const list = document.getElementById('hb-list');
    const recent = entries.slice(-3).reverse();
    // 口令是外部输入，只作为文本节点写入，不参与 DOM 结构。
    list.replaceChildren(...recent.map((entry) => {
      const item = document.createElement('li');
      item.className = 'hb-row';
      const code = document.createElement('code');
      code.className = 'hb-code';
      code.textContent = String(entry.code || '（无口令）');
      const status = document.createElement('span');
      status.className = 'hb-status ' + (STATUS_CLASS[entry.status] || 'hb-status--idle');
      status.textContent = STATUS_LABEL[entry.status] || '未知';
      item.append(code, status);
      return item;
    }));
    list.hidden = recent.length === 0;
    document.getElementById('hb-empty').textContent = recent.length
      ? ''
      : '尚未接入口令提交，队列为空。';
    document.getElementById('hb-empty').hidden = recent.length > 0;
  }

  function render(state) {
    renderList(state);
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
