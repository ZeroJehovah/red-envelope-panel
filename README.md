# 红包口令面板（浏览器扩展）

把 [scripts](https://github.com/ZeroJehovah/scripts) 仓库中的 `linuxdo-hongbao-code-sidebar.user.js`（原先挂在论坛侧边栏上的红包口令脚本）改造成 Chrome 扩展：在扩展图标弹出面板里提交 hb.unsnow.org 口令，或把面板固定在浏览器侧边栏常显。

面板运行在浏览器层，**与浏览的网站无关**：不需要在论坛页面注入任何东西，刷任何网站时都能随时打开提交口令、查看领取结果。

## 当前状态

里程碑 1（仓库与骨架）：清单、后台状态层、弹出面板、常显侧边栏外壳、图标与静态自检已完成。口令提交、领取、队列、历史与限时抽奖在后续里程碑接入，计划见 `docs/开发计划/浏览器插件化.md`。

## 形态

- **弹出面板**：点扩展图标打开，适合临时提交一两条口令；在任意标签页都能唤出。
- **常显侧边栏**：`chrome.sidePanel`，可固定常显，适合一边浏览一边等待领取结果。
- **站点内嵌模式**（可选，后续里程碑）：沿用脚本版贴在页面右侧的停靠/悬浮形态；只有到这一步才需要申请对应站点的访问权限。

## 安装（开发）

Chrome（Manifest V3，116+）：

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录 `src/`

## 目录

- `manifest.json`（MV3）、`background.js`（service worker）、`browser-shim.js`（兼容层）
- `popup.*`（点图标面板）、`sidepanel.*`（常显侧边栏）、`panel.js`／`panel.css`（两者共用的面板渲染与样式）
- `icons/`、`tools/`、`tests/`

约束与设计说明见 `AGENTS.md`，需求与计划见同级 `docs/`。

静态自检：在 `src/` 下执行 `node --test`。
