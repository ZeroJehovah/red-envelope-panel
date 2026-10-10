/* browser/chrome 兼容层。
 * 后台以 importScripts 引入，扩展页面与内容脚本以 <script src> / content_scripts.js 引入，
 * 统一暴露 globalThis.HBApi，业务代码不再直接判断浏览器前缀。
 * Firefox 的侧边栏（sidebar_action）在后续里程碑接入时在这里补适配。
 */
'use strict';

globalThis.HBApi = globalThis.browser ?? globalThis.chrome;
