/* hb.unsnow.org 红包口令面板：后台 service worker。
 *
 * 里程碑 1 的职责：持有唯一状态副本、响应扩展页面与内容脚本的消息。
 * 里程碑 3 起：代理 hb.unsnow.org 请求，串行化 5 秒限速与领取写入。
 *
 * MV3 提示：worker 空闲即休眠，内存变量不可跨唤醒保留，所有状态先读 chrome.storage.local。
 */
'use strict';

importScripts('browser-shim.js');

const api = globalThis.HBApi;
const VERSION = api.runtime.getManifest().version;

// 状态键沿用脚本版语义：entries 是口令历史，removed 是按 ID 的墓碑，settings 是面板配置。
const STATE_KEY = 'hb-state-v1';
const DEFAULT_SETTINGS = Object.freeze({
  charset: 'text',       // 'text'：6-18 字符文本口令；'numeric'：8 位数字口令
  batch: false,          // false：单个口令；true：批量口令（每行一条）
  claimMode: 'manual',   // 'manual'：古法，弹窗手动开启；'direct'：协议，直接领取
  gapExtraMs: 0,         // 在 5 秒基础间隔之上追加的等待时间
  display: 'panel',      // 'panel'：点图标弹出面板；'sidebar'：常显侧边栏
});

function emptyState() {
  return { entries: [], removed: [], settings: { ...DEFAULT_SETTINGS } };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadState() {
  const stored = await api.storage.local.get(STATE_KEY);
  const saved = stored?.[STATE_KEY];
  if (!isPlainObject(saved)) return emptyState();
  return {
    entries: Array.isArray(saved.entries) ? saved.entries : [],
    removed: Array.isArray(saved.removed) ? saved.removed : [],
    settings: { ...DEFAULT_SETTINGS, ...(isPlainObject(saved.settings) ? saved.settings : {}) },
  };
}

async function patchState(patch) {
  const state = await loadState();
  const next = {
    entries: Array.isArray(patch?.entries) ? patch.entries : state.entries,
    removed: Array.isArray(patch?.removed) ? patch.removed : state.removed,
    settings: { ...state.settings, ...(isPlainObject(patch?.settings) ? patch.settings : {}) },
  };
  await api.storage.local.set({ [STATE_KEY]: next });
  return next;
}

// 消息契约（扩展页面与内容脚本 → 后台）。
// hb:ping         → { ok, version }
// hb:state:get    → { ok, state }
// hb:state:patch  → { ok, state }（patch 只接受 entries/removed 整体替换与 settings 合并）
// hb:request      → 里程碑 3 实现（载荷 { codes: [{ code, charset }], claimMode }），
//                   当前明确拒绝，避免面板误以为已经发出请求
async function handleMessage(message) {
  switch (message?.type) {
    case 'hb:ping':
      return { ok: true, version: VERSION };
    case 'hb:state:get':
      return { ok: true, state: await loadState() };
    case 'hb:state:patch':
      return { ok: true, state: await patchState(message.patch || {}) };
    case 'hb:request':
      return { ok: false, error: '请求代理尚未实现（里程碑 3）' };
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

api.runtime.onInstalled.addListener(() => loadState().then((state) => {
  // 首次安装写入默认配置，面板据此渲染；重复安装不覆盖用户配置。
  return api.storage.local.get(STATE_KEY).then((stored) => {
    if (isPlainObject(stored?.[STATE_KEY])) return undefined;
    return api.storage.local.set({ [STATE_KEY]: state });
  });
}));
