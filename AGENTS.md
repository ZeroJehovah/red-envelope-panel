# src 源码约束（红包口令面板扩展）

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码、图标与公开说明，不放账号、Cookie、令牌、密钥、真实领取记录或内部抓包记录。

扩展定位在**浏览器层**：面板与浏览的网站无关，不在页面里注入 UI，也不申请浏览站点的访问权限；只有后续可选的站点内嵌模式才需要单独评估站点权限。

## 结构

```text
src/
├── manifest.json      # WebExtension 清单（MV3，Chrome 116+，side panel）
├── rules.json         # 静态声明式规则：把 /api/ 写请求的 Origin/Referer 改写成站点来源
├── browser-shim.js    # browser/chrome 兼容层，暴露 globalThis.HBApi
├── code-rules.js      # 口令清洗、分享文案取词与校验规则（纯逻辑，暴露 globalThis.HBCodes）
├── hb-protocol.js     # 红包站协议层：端点、错误文案与结果行（纯函数，暴露 globalThis.HBProtocol）
├── background.js      # service worker：状态持有者、消息路由、请求代理、限速与队列
├── panel.js           # 弹出面板与侧边栏共用渲染器：按脚本版 ensurePanel() 复刻的头部开关、配置面板、输入区与历史区（HBPanel.mount）
├── panel.css          # 面板共用样式（莫兰迪配色）
├── envelope.js        # 面板内红包详情卡片（信封弹窗、领取记录、抽奖倒计时与名单，暴露 globalThis.HBEnvelope）
├── envelope.css       # 卡片样式（挂进 #hb-envelope-host 的 shadow root，卡片内部沿用站点红/金配色，按面板可用尺寸铺满）
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
- **面板结构**：`panel.js` / `panel.css` 按脚本版 `ensurePanel()` 1:1 复刻（头部两个开关与三个图标按钮、可折叠的配置面板、输入区与「拆红包」＋字数提示、暂停横幅与「恢复执行」、历史头与逐行动作、点击历史口令填入输入框）。「悬浮/停靠」分别映射到点图标弹出的面板与浏览器常显侧边栏，窗口的位置与尺寸交给浏览器，不要重新引入脚本版的拖拽与八向缩放手柄。
- **详情卡片**：红包详情（金额、领取进度与记录、抽奖倒计时与名单）由 `envelope.js` 挂在面板页面内的 shadow DOM 宿主 `#hb-envelope-host` 上，一次只显示一张卡片；不向浏览的网页注入任何 DOM 或样式。卡片头像只从 `hb.unsnow.org` 来源加载，其他一律回落到内联 SVG data URI。卡片保持**原尺寸**（原站 320×520、抽奖卡 420×640，再乘原站 1.2 倍缩放），窗口不够大就加大窗口而不是缩卡片：`--envelope-zoom` 恒为 1.2，不要引入原站那条窄屏/矮屏的 0.8 倍降级。卡片本体只有一层：`createNode()` 已经建出 `.redpacket-envelope`，markup 里不得再套同名 class。宿主是固定定位、盖住整个面板的一层，**关闭卡片时必须连宿主一起撤掉**（`host.remove()`）并让 `:host` 在无卡片时 `pointer-events: none`，否则留下一层透明宿主会把面板的点击整个吞掉。
- **写请求来源**：站点 POST 接口只认自己那一个 `Origin`，扩展自动附带的 `Origin: chrome-extension://<id>` 会被回 403「请求来源不合法」。因此清单常带 `declarativeNetRequestWithHostAccess` 权限与 `rules.json`（改写 `https://hb.unsnow.org/api/` 的 `Origin`/`Referer`）；两者必须在同一次改动里保持同步，`tests/manifest.test.cjs` 会守住这条。
- **站点无关**：不注册内容脚本、不注入页面 DOM 或样式、不依赖任何浏览站点的 DOM 结构；可选的站点内嵌模式必须单独引入权限并在此处登记。
- **状态**：`chrome.storage.local` 的 `hb-state-v1` 是唯一真实来源；所有写入必须经后台消息接口，扩展页面不做本地副本。
- **领取授权**：任何写操作（领取、参与抽奖）都必须由真实用户点击授权，一次点击只放行一次请求；已发送的领取不自动重试。
- **限速**：两次请求之间不低于 5 秒基础间隔加设置中的加时，刻度按「上一次请求**结束**到下一次请求**开始**」计算，跨面板、跨标签页共用同一节奏；时间戳写在 `hb-state-v1.lastFinishedAt`（旧字段 `lastStartedAt` 迁移时取较大值），worker 被回收后依然生效。「一次操作」指一条口令的「查询 + 领取」、一次开奖看护轮询或一次详情读取：操作里连发的多个请求只在开始前等一次，操作的最后一次请求结束才刷新刻度；站点的写接口（领取、参与抽选）同样受限速约束，古法点击也要等间隔满足后才发 POST（等待期间条目已在途，重复点击照旧被挡下）。`/api/me` 会话查询不占刻度。
- **CSP**：不加载远程代码、样式、字体；图标随包，头像等图形一律用 data URI 或内联 SVG。

## 消息契约（扩展页面 → 后台）

| 消息 | 载荷 | 返回 |
|---|---|---|
| `hb:ping` | — | `{ ok, version }` |
| `hb:state:get` | — | `{ ok, state }` |
| `hb:state:patch` | `{ settings }` | `{ ok, state }`（settings 合并） |
| `hb:submit` | `{ codes: [{ code, charset }], claimMode }` | `{ ok, added, state }` |
| `hb:claim` | `{ id, trusted: true }` | `{ ok, state, outcome, packet }` |
| `hb:packet` | `{ id, refresh }` | `{ ok, packet }`（先查内存缓存，`refresh: true` 才发一次只读 GET，绝不下写请求） |
| `hb:void` / `hb:delete` / `hb:void-all` / `hb:clear` / `hb:resume` | `{ id }`（按需） | `{ ok, state }` |
| `hb:session` | — | `{ ok, loggedIn, username, linuxdo_id }` |

- 面板不直接写 storage：所有写入经这些消息进后台，重绘统一靠 `storage.onChanged`。
- `hb:claim` 的授权由两侧共同保证：面板只在 `event.isTrusted` 的真实点击里发送，后台只认 `awaiting` 且 `packetId` 匹配的条目，并抢在发请求前把状态改成 `running`，因此一次点击只放行一次请求，重复点击会被挡下。
- 领取失败或结果无法确认时条目落到 `failed` 并把队列置为暂停（`paused` / `pausedReason`），要用户核对后手动「继续队列」，不做自动重试。
- 领取记录、参与者与中奖名单只存在后台内存（`livePackets`），随 worker 回收消失，不写进 `hb-state-v1`；卡片重开时按需用 `hb:packet` 的只读请求补回。持久化的 `packetSnapshot` 只留列表需要的字段。

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
- 面板 DOM 自检：把 `tests/panel-harness.html` 复制到扩展产物目录（与 `manifest.json` 同级），用 Chrome 打开或用无头模式 `--dump-dom` 运行（`--window-size=560,900`；窗口至少 424×668 卡片才会铺到原尺寸 384×624，更小的窗口只验证宽度，高度按视口推算）；标题为 `HARNESS-PASS`、`#harness-result` 里 `FAIL 0` 即通过。该文件只用于开发期，不随扩展发布。

## 产物同步（强制）

- 每轮迭代结束（含提交与推送）后，把 `src/` 镜像到 `D:\Green Files\chrome plugins\red-envelope-panel\`，再在 `chrome://extensions` 重新加载该目录确认版本号与面板可用。
- 镜像命令（9p 文件系统下 `rsync -a` 会报 code 23，因此逐项降级并排除开发期文件）：

  ```bash
  rsync -r --delete --inplace --no-perms --no-owner --no-group --no-times \
    --exclude '.git/' --exclude 'tests/' --exclude 'tools/' \
    --exclude 'AGENTS.md' --exclude '.gitignore' --exclude '_metadata/' \
    src/ "/mnt/d/Green Files/chrome plugins/red-envelope-panel/"
  ```

- `_metadata/` 必须排除：Chrome 加载解压扩展后会自己在目标目录里生成它，不排除会被镜像删掉。改完后用 `diff -r -x _metadata src "/mnt/d/Green Files/chrome plugins/red-envelope-panel"` 核对（只应剩下 `tests/`、`tools/`、`AGENTS.md`、`.gitignore` 这几项差异）。
