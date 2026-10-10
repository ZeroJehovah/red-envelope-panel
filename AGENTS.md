# src 源码约束（红包口令面板扩展）

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码、图标与公开说明，不放账号、Cookie、令牌、密钥、真实领取记录或内部抓包记录。

扩展定位在**浏览器层**：面板与浏览的网站无关，不在页面里注入 UI，也不申请浏览站点的访问权限；只有后续可选的站点内嵌模式才需要单独评估站点权限。

## 结构

```text
src/
├── manifest.json      # WebExtension 清单（MV3，Chrome 116+，side panel）
├── browser-shim.js    # browser/chrome 兼容层，暴露 globalThis.HBApi
├── background.js      # service worker：状态持有者、消息路由、hb.unsnow.org 请求代理
├── panel.js           # 弹出面板与侧边栏共用渲染器（HBPanel.mount）
├── panel.css          # 面板共用样式（莫兰迪配色）
├── popup.html/.js     # 点图标弹出面板的外壳
├── sidepanel.html/.js # 常显侧边栏的外壳
├── icons/             # 16/32/48/128 PNG（由 tools/make-icons.py 生成）
├── tools/             # 开发期脚本，不随扩展逻辑运行
└── tests/             # node:test 静态自检
```

## 硬性约束

- **无构建步骤**：纯静态脚本，直接加载 `src/` 即可运行；不引入打包器、npm 依赖或远程资源。
- **脚本形态**：后台与内容脚本使用普通脚本 + `importScripts`／`<script src>`，共享能力统一挂在 `globalThis.HBApi`（见 `browser-shim.js`），不依赖模块解析顺序以外的工具。
- **网络**：只允许访问 `https://hb.unsnow.org`；跨域请求只能由后台 service worker 发起，扩展页面不得直接请求。
- **站点无关**：不注册内容脚本、不注入页面 DOM 或样式、不依赖任何浏览站点的 DOM 结构；可选的站点内嵌模式必须单独引入权限并在此处登记。
- **状态**：`chrome.storage.local` 的 `hb-state-v1` 是唯一真实来源；所有写入必须经后台消息接口，扩展页面不做本地副本。
- **领取授权**：任何写操作（领取、参与抽奖）都必须由真实用户点击授权，一次点击只放行一次请求；已发送的领取不自动重试。
- **限速**：两次向 hb.unsnow.org 发起的查询间隔不低于 5 秒基础间隔加设置中的加时，跨面板、跨标签页共用同一节奏。
- **CSP**：不加载远程代码、样式、字体；图标随包，头像等图形一律用 data URI 或内联 SVG。

## MV3 注意事项

- 后台是 service worker，空闲会被休眠，内存态不可跨唤醒保留，每次操作先 `loadState()`。
- 异步事件监听（`onMessage`／`onInstalled`）必须返回 `true` 或 Promise，否则 worker 会在异步完成前被挂起。
- 面板（popup）关闭即销毁，长任务与队列只能存在于后台；`chrome.sidePanel.open()` 需要用户手势且为 Chrome 116+。

## 版本号

- 版本号只写在 `manifest.json` 的 `version`，扩展页面通过 `chrome.runtime.getManifest().version` 读取，禁止在 HTML/JS 中硬编码。
- 递增规则见 `docs/AGENTS.md`。

## 图标

- `tools/make-icons.py` 生成 16/32/48/128 PNG；配色遵循 `docs/AGENTS.md` 的红包红与封口金，风格保持线性简洁。
- 改动配色后重新生成图标，不要手改像素。

## 加载与自检

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选择 `src/`。
- 静态自检：在 `src/` 下执行 `node --test`（清单、引用文件、版本号与远程资源检查）。
