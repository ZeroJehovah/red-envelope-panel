# src 源码约束（红包口令面板扩展）

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码、图标与公开说明，不放账号、Cookie、令牌、密钥、真实领取记录或内部抓包记录。

扩展定位在**浏览器层**：面板与浏览的网站无关，不在页面里注入 UI，也不申请浏览站点的访问权限；只有后续可选的站点内嵌模式才需要单独评估站点权限。

## 结构

```text
src/
├── manifest.json      # WebExtension 清单（MV3，Chrome 116+，side panel）
├── browser-shim.js    # browser/chrome 兼容层，暴露 globalThis.HBApi
├── code-rules.js      # 口令清洗、分享文案取词与校验规则（纯逻辑，暴露 globalThis.HBCodes）
├── hb-protocol.js     # 红包站协议层：端点、错误文案与结果行（纯函数，暴露 globalThis.HBProtocol）
├── background.js      # service worker：状态持有者、消息路由、请求代理、限速与队列
├── panel.js           # 弹出面板与侧边栏共用渲染器：口令输入区、队列与历史区（HBPanel.mount）
├── panel.css          # 面板共用样式（莫兰迪配色）
├── popup.html/.js     # 点图标弹出面板的外壳
├── sidepanel.html/.js # 常显侧边栏的外壳
├── icons/             # 16/32/48/128 PNG（由 tools/make-icons.py 生成）
├── tools/             # 开发期脚本，不随扩展逻辑运行
└── tests/             # node:test 自检（清单、口令规则、后台集成）与面板 DOM 自检页（panel-harness.html）
```

## 硬性约束

- **无构建步骤**：纯静态脚本，直接加载 `src/` 即可运行；不引入打包器、npm 依赖或远程资源。
- **脚本形态**：后台与内容脚本使用普通脚本 + `importScripts`／`<script src>`，共享能力统一挂在 `globalThis.HBApi`（见 `browser-shim.js`），不依赖模块解析顺序以外的工具。
- **口令规则**：字符清洗、分享文案取词与校验集中在 `code-rules.js`（暴露 `globalThis.HBCodes`），面板与 `node --test` 共用同一份实现；规则按脚本版原样保留（含站点标识匹配），不要在两处各写一份。
- **协议层**：端点、错误文案与结果行集中在 `hb-protocol.js`（暴露 `globalThis.HBProtocol`），后台与 `node --test` 共用；文案按脚本版移植，改文案只改这一处。
- **网络**：只允许访问 `https://hb.unsnow.org`；跨域请求只能由后台 service worker 发起（`credentials: 'include'` 携带会话 Cookie，15 秒超时），扩展页面不得直接请求。
- **站点无关**：不注册内容脚本、不注入页面 DOM 或样式、不依赖任何浏览站点的 DOM 结构；可选的站点内嵌模式必须单独引入权限并在此处登记。
- **状态**：`chrome.storage.local` 的 `hb-state-v1` 是唯一真实来源；所有写入必须经后台消息接口，扩展页面不做本地副本。
- **领取授权**：任何写操作（领取、参与抽奖）都必须由真实用户点击授权，一次点击只放行一次请求；已发送的领取不自动重试。
- **限速**：两次向 hb.unsnow.org 发起的查询间隔不低于 5 秒基础间隔加设置中的加时，跨面板、跨标签页共用同一节奏；时间戳写在 `hb-state-v1.lastStartedAt`，worker 被回收后依然生效。
- **CSP**：不加载远程代码、样式、字体；图标随包，头像等图形一律用 data URI 或内联 SVG。

## 消息契约（扩展页面 → 后台）

| 消息 | 载荷 | 返回 |
|---|---|---|
| `hb:ping` | — | `{ ok, version }` |
| `hb:state:get` | — | `{ ok, state }` |
| `hb:state:patch` | `{ settings }` | `{ ok, state }`（settings 合并） |
| `hb:submit` | `{ codes: [{ code, charset }], claimMode }` | `{ ok, added, state }` |
| `hb:claim` | `{ id, trusted: true }` | `{ ok, state }` |
| `hb:void` / `hb:delete` / `hb:void-all` / `hb:clear` / `hb:resume` | `{ id }`（按需） | `{ ok, state }` |
| `hb:session` | — | `{ ok, loggedIn, username }` |

- 面板不直接写 storage：所有写入经这些消息进后台，重绘统一靠 `storage.onChanged`。
- `hb:claim` 的授权由两侧共同保证：面板只在 `event.isTrusted` 的真实点击里发送，后台只认 `awaiting` 且 `packetId` 匹配的条目，并抢在发请求前把状态改成 `running`，因此一次点击只放行一次请求，重复点击会被挡下。
- 领取失败或结果无法确认时条目落到 `failed` 并把队列置为暂停（`paused` / `pausedReason`），要用户核对后手动「继续队列」，不做自动重试。

## MV3 注意事项

- 后台是 service worker，空闲会被休眠，内存态不可跨唤醒保留，每次操作先 `loadState()`。
- 异步事件监听（`onMessage`／`onInstalled`）必须返回 `true` 或 Promise，否则 worker 会在异步完成前被挂起。
- 队列用内存定时器追求精度，用 `chrome.alarms`（30 秒粒度）兜底唤醒；正确性只依赖 `chrome.storage.local` 里的状态与限速时间戳，不依赖内存定时器是否幸存。
- 面板（popup）关闭即销毁，长任务与队列只能存在于后台；`chrome.sidePanel.open()` 需要用户手势且为 Chrome 116+。

## 版本号

- 版本号只写在 `manifest.json` 的 `version`，扩展页面通过 `chrome.runtime.getManifest().version` 读取，禁止在 HTML/JS 中硬编码。
- 递增规则见 `docs/AGENTS.md`。

## 图标

- `tools/make-icons.py` 生成 16/32/48/128 PNG；配色遵循 `docs/AGENTS.md` 的红包红与封口金，风格保持线性简洁。
- 改动配色后重新生成图标，不要手改像素。

## 加载与自检

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选择 `src/`。
- 静态自检：在 `src/` 下执行 `node --test`（清单与引用文件、口令规则用例，以及后台集成自检：vm 沙箱 + 假时钟 + 假 `fetch` 驱动真实消息契约）。
- 面板 DOM 自检：把 `tests/panel-harness.html` 复制到扩展产物目录（与 `manifest.json` 同级），用 Chrome 打开或用无头模式 `--dump-dom` 运行；标题为 `HARNESS-PASS`、`#harness-result` 里 `FAIL 0` 即通过。该文件只用于开发期，不随扩展发布。
