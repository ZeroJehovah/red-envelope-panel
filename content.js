/* linux.do 内容脚本。
 *
 * 里程碑 1 只登记探针消息，用于确认内容脚本可用，不改写论坛页面的任何 DOM。
 * 里程碑 2 起在这里接入页面内停靠/悬浮模式：与扩展面板共用后台状态层，
 * 不复制一份本地状态，也不直接向 hb.unsnow.org 发起请求。
 */
'use strict';

const api = globalThis.HBApi;

api.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'hb:page:probe') return undefined;
  return { ok: true, url: location.href, title: document.title };
});
