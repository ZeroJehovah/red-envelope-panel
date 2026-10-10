/* 常显侧边栏：与弹出面板共用 panel.js，宽度由浏览器侧边栏决定，不再提供打开侧边栏的入口。 */
'use strict';

globalThis.HBPanel.mount(document.getElementById('app'), { allowSidePanelOpen: false });
