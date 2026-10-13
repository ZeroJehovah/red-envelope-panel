# src 源码约束（红包口令面板扩展）

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码、图标与公开说明，不放账号、Cookie、令牌、密钥、真实领取记录或内部抓包记录。

扩展定位在**浏览器层**：面板与浏览的网站无关，不在页面里注入 UI，也不申请浏览站点的访问权限；可选的站点内嵌模式已评估并放弃（v0.9.6），不要自行把站点权限或内容脚本引回来。红包详情卡片同样不挤进面板，由面板另开一个扩展自己的小窗口来放（v0.9.7）——弹出面板受浏览器弹窗高度上限（600px）限制，原尺寸卡片铺不下。

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
├── panel.css          # 面板共用样式（脚本版/linux.do 调色板，亮暗两套）
├── envelope.js        # 红包详情卡片（信封弹窗、领取记录、抽奖倒计时与名单，暴露 globalThis.HBEnvelope）；卡片画在详情窗口里，面板只借它算开窗尺寸
├── envelope.css       # 卡片样式（挂进卡片宿主的 shadow root，卡片内部沿用站点红/金配色，按窗口尺寸铺满）
├── card.html/.js      # 红包详情窗口的外壳：窗口里只放一张卡片，按 URL 上的红包 id 渲染；数据回来之前只有一层 loading
├── card.css           # 详情窗口页面这一层的外框样式（暗底 + loading 那一层；卡片样式仍由 envelope.css 提供）
├── popup.html/.js     # 点图标弹出面板的外壳
├── sidepanel.html/.js # 常显侧边栏的外壳
├── icons/             # 16/32/48/128 PNG（由 tools/make-icons.py 生成）
├── tools/             # 开发期脚本，不随扩展逻辑运行
└── tests/             # node:test 自检（清单、口令规则、后台集成）与两个 DOM 自检页（panel-harness.html、card-harness.html）
```

## 硬性约束

- **无构建步骤**：纯静态脚本，直接加载 `src/` 即可运行；不引入打包器、npm 依赖或远程资源。
- **脚本形态**：后台与内容脚本使用普通脚本 + `importScripts`／`<script src>`，共享能力统一挂在 `globalThis.HBApi`（见 `browser-shim.js`），不依赖模块解析顺序以外的工具。
- **口令规则**：字符清洗、分享文案取词与校验集中在 `code-rules.js`（暴露 `globalThis.HBCodes`），面板与 `node --test` 共用同一份实现；规则按脚本版原样保留（含站点标识匹配），不要在两处各写一份。
- **协议层**：端点、错误文案与结果行集中在 `hb-protocol.js`（暴露 `globalThis.HBProtocol`），后台与 `node --test` 共用；文案按脚本版移植，改文案只改这一处。
- **网络**：只允许访问 `https://hb.unsnow.org`；跨域请求只能由后台 service worker 发起（`credentials: 'include'` 携带会话 Cookie，15 秒超时），扩展页面不得直接请求。
- **面板结构**：`panel.js` / `panel.css` 按脚本版 `ensurePanel()` 1:1 复刻（头部两个开关与三个图标按钮、可折叠的配置面板（领取方式三段开关——古法／协议／动态，`role="radiogroup"`；只有选了动态才多出「领取阈值」那一行，见「领取方式与动态阈值」）、输入区与「拆红包」＋字数提示、暂停横幅与「恢复执行」、历史头与逐行动作、点击历史口令填入输入框）。「悬浮/停靠」分别映射到点图标弹出的面板与浏览器常显侧边栏，窗口的位置与尺寸交给浏览器，不要重新引入脚本版的拖拽与八向缩放手柄。弹出面板宽度 `400px`（v0.9.11 从 560px 收窄——那个宽度是当初为了在面板里铺开 504px 的抽奖卡定的，卡片从 v0.9.7 起在独立窗口里，面板没有需要横向铺开的宽内容了；再窄会挤掉头部那一行）。
- **图标点击去向**：`settings.display` 是用户的持久选择，也决定点扩展图标做什么——`'sidebar'`（停靠）时图标交给浏览器开合侧边栏、popup 清掉，`'panel'`（悬浮）时图标弹 `popup.html`。这两件事只有后台改得了，所以由 `background.js` 的 `syncActionMode()` 统一执行（`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick })` + `chrome.action.setPopup({ popup })`），调用点是「设置变更后」「`onInstalled`」「`onStartup`」「worker 起来时」；面板**不得**再按眼前形态去改写这个设置（侧边栏挂载/收起、`pagehide`／`visibilitychange` 都不许动它），否则「手动关掉侧边栏后下次点图标还是停靠」这条就没了（v0.10.0 取代了 v0.9.1 的「跟着实际形态走」）。`syncActionMode` 内部有「值没变就不写」的缓存，改这几条要同步改 `tests/manifest.test.cjs` 与 `tests/background.test.cjs`。
- **打开即聚焦**：弹出面板与常显侧边栏打开后，焦点默认落在输入框（单个模式 `#hb-input`、批量模式 `#hb-textarea`）。侧边栏的交焦点比页面加载晚——Chrome 把面板挂进窗口右侧之后才把焦点交过去，还可能先落在面板里别的元素（甚至空的 `body`）上，所以**不是放一次就算**：第一次渲染回来后放一次，挂载后按 `[60, 200, 450, 900, 1600]ms` 再补几次（哪次成了就把剩下的撤掉），`visibilitychange` 重新露出来、窗口 `focus` 时各补一次（`focusField()` 先 `window.focus()` 再 `field.focus()`；`window.focus()` 可能同步抛回 `focus` 事件，用 `focusing` 这道闸挡住兜圈）。唯一不插手的信号是用户自己动过键盘鼠标（`pointerdown`/`keydown` 捕获阶段记一笔 `userTouched`）——那时焦点是他选的；面板被收起来（`visibilitychange` 非 visible）时把这笔记录清掉，下次露出来重新按「刚打开」处理。模式开关切换时同理：要等输入框显隐跟着 `settings` 换过来再放焦点（`pendingFieldFocus`），别在切换那一刻对着还藏着的那个控件 `focus()`。
- **面板配色**：`panel.css` 用脚本版那套站点调色板（linux.do 亮色方案 `color_definitions_scheme_-1` + 暗色方案 `color_definitions_scheme_105`），**亮暗两套都要覆盖**（`@media (prefers-color-scheme: dark)`），色值表与变量对应关系见 `docs/AGENTS.md` 的配色规范；`.hb-entry-packet` 那三处站点品牌色（`#dc2626` / `#b91c1c` / `#eab308`）与「拆红包」的 `#dc2626` 是写死的站点色，不随主题变，也不要改回面板自身的界面红。
- **详情卡片**：红包详情（金额、领取进度与记录、抽奖倒计时与名单）由 `envelope.js` 挂在**详情窗口**（`card.html` + `card.js`）自己的 shadow DOM 宿主 `#hb-envelope-host` 上，一次只显示一张卡片；不在网页里，也不在面板页面里——弹出面板受浏览器弹窗高度上限（600px）限制，卡片按原尺寸（普通 384×624、抽奖 504×768）会被 `height: min()` 压扁。不向浏览的网页注入任何 DOM 或样式。卡片头像按原站 `claimAvatarSrc` 用站点返回的 `avatar_url`（通常是论坛 CDN `cdn.ldstatic.com`），取不到或不是 http(s) 才回落到内联 SVG data URI；协议请求仍然只发往 `hb.unsnow.org`（v0.9.8 改）。卡片保持**原尺寸**（原站 320×520、抽奖卡 420×640，再乘原站 1.2 倍缩放）：`envelope.js` 的 `windowSize` / `windowOuterSize` 把卡片显示尺寸加上 `.modal-overlay` 的留白算成开窗尺寸，窗口起来后再按 `outer - inner` 的真实差值收紧一次（最多两轮）；屏幕装不下就不动尺寸，让卡片自己按视口收住。`--envelope-zoom` 恒为 1.2，不要引入原站那条窄屏/矮屏的 0.8 倍降级。卡片是展示层，打开时**不要**调用 `focus()`——浏览器会给这张 `tabindex="-1"` 的卡片套上默认焦点圈，在独立窗口里就是「卡片被选中、四周多一圈白边」，`.redpacket-envelope` 上的 `outline: none` 只是兜底。窄屏/矮屏分支只保留 `.envelope-details` 可滚动与 `#envelope-opened-view > :not(.envelope-claims-list)` 不缩这两条，不要给 `.envelope-close-btn`／`.envelope-claims-list` 另加 `min-height`（v0.9.10 删掉的 `55px`／`48px` 是我们自己加的，会让「确定」按钮比原生高出一截）。卡片本体只有一层：`createNode()` 已经建出 `.redpacket-envelope`，markup 里不得再套同名 class。宿主是固定定位、盖住整个窗口的一层，**关闭卡片时必须连宿主一起撤掉**（`host.remove()`）并让 `:host` 在无卡片时 `pointer-events: none`。卡片样式随包（`envelope.css`）：窗口一加载就把它读成一张 constructable stylesheet，开卡片时同步挂到 shadow root 上，只有读不到时才退回 `<link>` 并在这期间先藏住卡片——`<link>` 是异步的，暗色主题下卡片会先按浏览器默认样式画一帧（v0.9.1）。
- **详情窗口**：按卡片种类各留一个（v0.11.0；此前全扩展只留一个）。窗口号与它当前那个红包 id 记在 `chrome.storage.session` 的 `hb-card-window`，按 `claim` / `detail` 两格分开放（只活这一次浏览器会话，重启即清；旧版本留下的扁平形状一律当没有）：同一格里同一个红包就把它拉到前面，换个红包就用 `windows.remove` 收掉这一格的旧窗口、按新卡片的尺寸重开一个（不要改成 `tabs.update` 去改已有窗口的地址：扩展页能不能被这样导航要看浏览器对扩展源给不给权限），认不到活着的窗口（被关掉了）才新开一个；窗口关掉时页面自己清掉自己那一格，条目在面板里被删掉时窗口自动关闭。窗口用 `windows.create({ type: 'popup' })` 开，不带标签栏与地址栏。**哪一格由条目状态决定**：`card-window.js` 的 `claimable(entry)`（`awaiting` + 古法 + 红包不是已报名的抽奖）为真时，面板点历史行开 `view=claim`——这是「待开启 + 古法」条目回到那张领取卡片的路（v0.11.1；后台只在「这一次刚查到可领」时自动弹卡，唤醒不补弹），其余一律 `view=detail`；`card.js` 是否挂领取入口也认这同一份判据。改这几条要同步改 `tests/manifest.test.cjs` 与 `tests/panel-harness.html`。**数据没到位之前窗口里不铺卡片**：`card.html` 里先摆着 `#hb-card-loading`（一个小转圈加「正在读取红包详情…」，样式在 `card.css`，亮暗两套都覆盖），`card.js` 要等详情读回来、`fitWindow()` 把窗口量准了才调 `envelope.show(...)`，卡片铺上再撤掉 loading；不要改成先把卡片铺出去、再慢慢补数据（原站同样是「先 await `/api/hongbao/<id>`、回来才把信封模态 active」，v0.9.12）。
- **写请求来源**：站点 POST 接口只认自己那一个 `Origin`，扩展自动附带的 `Origin: chrome-extension://<id>` 会被回 403「请求来源不合法」。因此清单常带 `declarativeNetRequestWithHostAccess` 权限与 `rules.json`（改写 `https://hb.unsnow.org/api/` 的 `Origin`/`Referer`）；两者必须在同一次改动里保持同步，`tests/manifest.test.cjs` 会守住这条。
- **站点无关**：不注册内容脚本、不注入页面 DOM 或样式、不依赖任何浏览站点的 DOM 结构。站点内嵌模式已放弃（v0.9.6，理由见 `docs/开发计划/浏览器插件化.md` 的 M7），这条是硬约束，不要自行放宽。
- **状态**：`chrome.storage.local` 的 `hb-state-v1` 是唯一真实来源；所有写入必须经后台消息接口，扩展页面不做本地副本。
- **领取授权**：任何写操作（领取、参与抽奖）都必须由真实用户点击授权，一次点击只放行一次请求；已发送的领取不自动重试。
- **领取方式与动态阈值**（v0.12.0）：`claimMode` 三态——`manual`（古法：查到可领弹领取卡片，等真实点击）、`direct`（协议：自动领取）、`dynamic`（动态：按阈值当场判定走前两者哪条）。动态的判定只能在**查到红包之后**做（总额／人均只有站点应答里才有），落在 `resolveClaimMode(entry, packet)` 一处：读「领取这一刻」的 `settings.claimMetric`（`total`／`average`）与 `settings.claimThreshold`（`hb-protocol.js` 的 `clampThreshold`：非负、四舍五入到两位小数、非法或负数归 `0`），用 `packetMetricValue(packet, metric)` 算出判定量（`average` = `total_amount / count`，抽奖按抽选人数 `count`；`count` 缺失或 ≤ 0 就算不出来），`value >= threshold` 走协议、否则古法；**算不出判定量一律按未达标处理**（转古法，绝不自动发写请求）。判定后把 `entry.claimMode` 固定改写为 `manual`／`direct`（不留 `dynamic`，因此 `card-window.js` 的 `claimable()` 与 `handleClaim` 只认 `manual` 的既有判据不用动），并往结果行写一句 `动态：<指标> <值> <≥|<> 阈值 <值>，自动协议领取｜转古法手动开启`。判定读的是**领取这一刻**的设置而不是提交时的快照：排队中的口令跟着最新阈值走，调完阈值不用重新提交。普通红包与抽奖同一条路子（抽奖的「领」是报名）。改这几条要同步改 `tests/background.test.cjs` 与 `tests/panel-harness.html`。
- **唤醒不是页面重载**（v0.11.1）：MV3 的 worker 被回收再唤醒是几十秒一次的常态，不能照脚本版「页面重载」的语义处理。带红包快照（`packetId` + `packet`）的 `awaiting` 条目唤醒后**原地待着**——不重查口令、不刷新限速刻度、不重弹领取卡片，存的几行结果原样留着；只有连快照都没有的老记录（画不出卡片）才回队列重新查询（`normalizeEntry` 里那条 `deferred` 判据）。已报名未开奖的抽奖把收摊时刻落库（那条记录的 `watchUntil`，绝对时刻），唤醒时 `normalizeState` 按它把看护装回来（`watchNextAt` 按唤醒时间重排；按 id 只读，不进限速），老记录缺这个字段时才自愈式重查一次口令补齐。`claimMode` 只认存下来的值，唤醒不再按状态改写（`dynamic` 条目一直留到查到红包那一刻才由 `resolveClaimMode` 判成 `manual`／`direct`，见「领取方式与动态阈值」）。代价是领取卡片关掉后条目仍是 `awaiting`，回到那张卡片的路是点历史行（见「详情窗口」）。改这几条要同步改 `tests/background.test.cjs`。
- **限速**：间隔（5 秒基础间隔加设置中的加时）只包**口令查询**这一条接口（v0.11.0 起）；刻度记「上一次口令查询**结束**」的时刻，下一次口令查询从那一刻起再等满间隔（刻度按「结束」而不是「开始」是 v0.9.2 的改动）。时间戳写在 `hb-state-v1.lastFinishedAt`（旧字段 `lastStartedAt` 迁移时取较大值），跨面板、跨标签页共用同一节奏，worker 被回收后依然生效。一条口令的「查询 + 领取」算一次操作，操作里连发的请求只在开始前等一次（协议模式的领取跟在同一次操作里）。**领取的那次 POST 不进这份节奏**（v0.12.1）：古法由点击触发，点「开」就当场发出去，既不等间隔、也不刷新刻度（等待期间条目已在途，重复点击照旧被挡下；v0.9.2 曾让它也等一次间隔，见「已完成」）。**按 id 只读同样不进这份节奏**：开奖看护轮询（自己数 `DRAW_POLL_INTERVAL_MS` 的 3 秒）、`hb:packet` 的按 id 读取与 `/api/me` 都既不等间隔、也不刷新刻度。详情窗口打开时先只问后台内存（`hb:packet` 带 `cache: true`，0 次请求），命中就一次请求都不发；内存里没有才在 loading 期间补一次只读 GET。**唤醒也不动刻度**（v0.11.1）：带快照的 `awaiting` 条目唤醒后原地待着，不会替用户重跑一遍口令把刻度顶到「刚刚」（那曾让闲置很久后提交的口令显示「排队中」，见「唤醒不是页面重载」）。
- **CSP**：不加载远程代码、样式、字体；图标随包，卡片头像按站点返回的 `avatar_url` 联网加载（v0.9.8）。清单的 `content_security_policy.extension_pages` 里 `img-src` 必须带 `https:`（v0.9.9 补），否则头像在发出请求前就被 CSP 整批拦掉——控制台报 `img-src 'self' data:`，卡片只会把头像换成占位图，看着像「头像又没了」；`script-src` 仍是 `'self'`、`connect-src` 仍只到 `https://hb.unsnow.org`，别跟着一起松。取不到或不是 http(s) 时回落到内联 SVG data URI。

## 消息契约（扩展页面 → 后台）

| 消息 | 载荷 | 返回 |
|---|---|---|
| `hb:ping` | — | `{ ok, version }` |
| `hb:state:get` | — | `{ ok, state }` |
| `hb:state:patch` | `{ settings }` | `{ ok, state }`（settings 合并） |
| `hb:submit` | `{ codes: [{ code, charset }], claimMode }`（`manual`／`direct`／`dynamic`） | `{ ok, added, state }` |
| `hb:claim` | `{ id, trusted: true }` | `{ ok, state, outcome, packet }` |
| `hb:packet` | `{ id, refresh, cache }` | `{ ok, packet }`（只读红包本身：默认先查内存缓存，`cache: true` 只问内存、内存里没有就直接返回错误且**一次请求都不发**，`refresh: true` 才发一次只读 GET；绝不下写请求） |
| `hb:void` / `hb:delete` / `hb:void-all` / `hb:clear` / `hb:resume` | `{ id }`（按需） | `{ ok, state }` |
| `hb:session` | — | `{ ok, loggedIn, username, linuxdo_id }` |

- 面板不直接写 storage：所有写入经这些消息进后台，重绘统一靠 `storage.onChanged`。
- `hb:claim` 的授权由两侧共同保证：面板只在 `event.isTrusted` 的真实点击里发送，后台只认 `awaiting` 且 `packetId` 匹配的条目，并抢在发请求前把状态改成 `running`，因此一次点击只放行一次请求，重复点击会被挡下。
- 领取失败或结果无法确认时条目落到 `failed` 并把队列置为暂停（`paused` / `pausedReason`），要用户核对后手动「继续队列」，不做自动重试。
- 领取记录、参与者与中奖名单只存在后台内存（`livePackets`），随 worker 回收消失，不写进 `hb-state-v1`；卡片重开时按需用 `hb:packet` 的只读请求补回。持久化的 `packetSnapshot` 只留列表需要的字段。详情窗口因此先发一次 `cache: true` 的内存读：命中就直接铺卡片，没命中才在 loading 后面补那次只读 GET（v0.9.12）。

## MV3 注意事项

- 后台是 service worker，空闲会被休眠，内存态不可跨唤醒保留，每次操作先 `loadState()`。
- 异步事件监听（`onMessage`／`onInstalled`）必须返回 `true` 或 Promise，否则 worker 会在异步完成前被挂起。
- 队列用内存定时器追求精度，用 `chrome.alarms`（30 秒粒度）兜底唤醒；正确性只依赖 `chrome.storage.local` 里的状态与限速时间戳，不依赖内存定时器是否幸存。
- 面板（popup）关闭即销毁，长任务与队列只能存在于后台；`chrome.sidePanel.open()` 需要用户手势且为 Chrome 116+。图标点击的去向（`sidePanel.setPanelBehavior` 与 `action.setPopup`）由浏览器记在扩展自己的偏好里，但**重载扩展会打回清单默认值**，所以 worker 每次起来都要按 `settings.display` 重放一次（见「图标点击去向」）。

## 版本号

- 版本号只写在 `manifest.json` 的 `version`，扩展页面通过 `chrome.runtime.getManifest().version` 读取，禁止在 HTML/JS 中硬编码。
- 递增规则见 `docs/AGENTS.md`。

## 图标

- `tools/make-icons.py` 生成 16/32/48/128 PNG；图形是面板历史行「查看红包详情」按钮里的那颗红包字形（`panel.js` 的 `PACKET_ICON_PATHS`，与脚本版网站行内按钮同一组 path）：前两段是红包本体，第三段是中间那枚封口盘。两段都照脚本版历史行那颗图标的站点色取值——主体 `#dc2626`、封口盘 `#eab308`（LINUXDO.md 的「主体红色且中间圆点金色」），面板里同一颗字形也是这套色（`panel.css` 的 `.hb-entry-packet` / `.hb-entry-packet:hover` / `.hb-packet-seal`），不走面板自身的界面红金。透明底，等比铺满画布高度、横向居中。
- 脚本自带一个只认 M/L/H/V/C/S/Z 的极简 path 光栅器：把 path 压成折线后按 2048 的母版填充，再降到各尺寸——字形里最细的负空间只有画布高度的 3.5% 左右，直接按目标尺寸画会让小尺寸下的封口圆环糊掉。本体与封口盘各画一层，合成顺序与面板里的 SVG 一致。
- 换字形或改配色后重新生成图标，不要手改像素。面板内的界面图标仍是随包的线性简洁写法（Lucide 风格，MIT）。

## 加载与自检

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选择 `src/`。
- 静态自检：在 `src/` 下执行 `node --test`（清单与引用文件、口令规则用例，以及后台集成自检：vm 沙箱 + 假时钟 + 假 `fetch` 驱动真实消息契约）。
- 面板 DOM 自检：把 `tests/panel-harness.html` 复制到扩展产物目录（与 `manifest.json` 同级），用 Chrome 打开或用无头模式 `--dump-dom` 运行（`--window-size=560,900` 即可，面板已不画卡片，这个尺寸只是给个正常窗口）；标题为 `HARNESS-PASS`、`#harness-result` 里 `FAIL 0` 即通过。该文件只用于开发期，不随扩展发布。
- 详情窗口 DOM 自检：把 `tests/card-harness.html` 同样复制到产物目录，`?id=` 后面换 `hp1`（普通红包，可领取）、`hp2`（抽奖未报名）、`hp3`（已开）、`hp4`（已领完且自己没领到）、`hp5`（后台内存里没有、要等一次只读查询）、`missing`（无此条目）各跑一遍；断言窗口尺寸按卡片收紧、卡片挂进宿主且样式先到位、卡片只有一层外壳、合成点击不授权、关掉卡片会关窗口并清掉会话存储里的窗口号，以及**数据回来之前窗口里只有 loading、不铺卡片**（`hp5`）与「还在等点击的卡片不在后台多占一次请求间隔」。无头下 `screen` 默认 800×600，自检页会先把 `screen.avail*` 顶上去，否则尺寸收紧那几项会被跳过。

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
