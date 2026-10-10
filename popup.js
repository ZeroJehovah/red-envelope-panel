/* 点图标弹出面板：与常显侧边栏共用 panel.js，额外提供「在侧边栏常显」入口。 */
'use strict';

globalThis.HBPanel.mount(document.getElementById('app'), { allowSidePanelOpen: true });
