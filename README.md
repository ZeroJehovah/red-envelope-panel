# linux.do - hb.unsnow.org 红包口令面板（浏览器扩展）

把 [scripts](https://github.com/ZeroJehovah/scripts) 仓库中的 `linuxdo-hongbao-code-sidebar.user.js`（论坛侧边栏红包口令脚本）改造成 Chrome 扩展：在扩展图标弹出面板里提交 hb.unsnow.org 口令，或把面板固定在浏览器侧边栏常显，不再依赖脚本管理器。

## 当前状态

里程碑 1（仓库与骨架）：清单、后台状态层、弹出面板、常显侧边栏外壳、图标与静态自检已完成。口令提交、领取、队列、历史与限时抽奖在后续里程碑接入，计划见 `docs/开发计划/浏览器插件化.md`。

## 形态

- **弹出面板**：点扩展图标打开，适合临时提交一两条口令。
- **常显侧边栏**：`chrome.sidePanel`，可固定常显，适合边刷论坛边等待领取结果。
- **页面内停靠/悬浮**（里程碑 2，可选）：沿用脚本版在论坛页面右侧的面板形态。

## 安装（开发）

Chrome（Manifest V3，116+）：

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录 `src/`

## 目录

- `manifest.json`（MV3）、`background.js`（service worker）、`browser-shim.js`（兼容层）
- `popup.*`（点图标面板）、`sidepanel.*`（常显侧边栏）、`panel.js`／`panel.css`（两者共用的面板渲染与样式）
- `content.js`（linux.do 内容脚本）、`icons/`、`tools/`、`tests/`

约束与设计说明见 `AGENTS.md`，需求与计划见同级 `docs/`。

静态自检：在 `src/` 下执行 `node --test`。
