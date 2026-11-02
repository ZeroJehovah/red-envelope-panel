# src 源码约束（红包口令面板扩展）

## 修改前必读

- 修改任意扩展源码、样式、清单或测试之前，必须读本仓库 [完整行为与实现约束](DEVELOPMENT.md)，其中保留现行窗口、焦点、领取、唤醒、限速和隐私规则。
- 配色表见私有文档仓库 `../docs/agent-reference/配色规范.md`；发布与产物同步见项目级指令及本文件末尾。
- 本文件目标 4–8 KiB；长实现说明维护在 `DEVELOPMENT.md`，不要再追加回自动注入文件。

## 定位

本目录是浏览器扩展源码，公开仓库。只放代码、图标与公开说明，不放账号、Cookie、令牌、密钥、真实领取记录或内部抓包记录。

扩展定位在**浏览器层**：面板与浏览的网站无关，不在页面里注入 UI，也不申请浏览站点的访问权限；可选的站点内嵌模式已评估并放弃（v0.9.6），不要自行把站点权限或内容脚本引回来。红包详情卡片同样不挤进面板，由面板另开一个扩展自己的小窗口来放（v0.9.7）——弹出面板受浏览器弹窗高度上限（600px）限制，原尺寸卡片铺不下。

## MV3 注意事项

- 后台是 service worker，空闲会被休眠，内存态不可跨唤醒保留，每次操作先 `loadState()`。
- 异步事件监听（`onMessage`／`onInstalled`）必须返回 `true` 或 Promise，否则 worker 会在异步完成前被挂起。
- 队列用内存定时器追求精度，用 `chrome.alarms`（30 秒粒度）兜底唤醒；正确性只依赖 `chrome.storage.local` 里的状态与限速时间戳，不依赖内存定时器是否幸存。
- 面板（popup）关闭即销毁，长任务与队列只能存在于后台；`chrome.sidePanel.open()` 需要用户手势且为 Chrome 116+。图标点击的去向（`sidePanel.setPanelBehavior` 与 `action.setPopup`）由浏览器记在扩展自己的偏好里，但**重载扩展会打回清单默认值**，所以 worker 每次起来都要按 `settings.display` 重放一次（见「图标点击去向」）。

## 版本号

- 版本号只写在 `manifest.json` 的 `version`，扩展页面通过 `chrome.runtime.getManifest().version` 读取，禁止在 HTML/JS 中硬编码。
- 递增规则见 `../docs/agent-reference/发布流程.md`。

## 图标

- `tools/make-icons.py` 生成 16/32/48/128 PNG；图形是面板历史行「查看红包详情」按钮里的那颗红包字形（`panel.js` 的 `PACKET_ICON_PATHS`，与脚本版网站行内按钮同一组 path）：前两段是红包本体，第三段是中间那枚封口盘。两段都照脚本版历史行那颗图标的站点色取值——主体 `#dc2626`、封口盘 `#eab308`（LINUXDO.md 的「主体红色且中间圆点金色」），面板里同一颗字形也是这套色（`panel.css` 的 `.hb-entry-packet` / `.hb-entry-packet:hover` / `.hb-packet-seal`），不走面板自身的界面红金。透明底，等比铺满画布高度、横向居中。
- 脚本自带一个只认 M/L/H/V/C/S/Z 的极简 path 光栅器：把 path 压成折线后按 2048 的母版填充，再降到各尺寸——字形里最细的负空间只有画布高度的 3.5% 左右，直接按目标尺寸画会让小尺寸下的封口圆环糊掉。本体与封口盘各画一层，合成顺序与面板里的 SVG 一致。
- 换字形或改配色后重新生成图标，不要手改像素。面板内的界面图标仍是随包的线性简洁写法（Lucide 风格，MIT）。

## 加载与自检

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」选择 `src/`。
- 静态自检：在 `src/` 下执行 `node --test`（清单与引用文件、口令规则用例，以及后台集成自检：vm 沙箱 + 假时钟 + 假 `fetch` 驱动真实消息契约）。
- 面板 DOM 自检：把 `tests/panel-harness.html` 复制到扩展产物目录（与 `manifest.json` 同级），用 Chrome 打开或用无头模式 `--dump-dom` 运行（`--window-size=560,900` 即可，面板已不画卡片，这个尺寸只是给个正常窗口）；标题为 `HARNESS-PASS`、`#harness-result` 里 `FAIL 0` 即通过。该文件只用于开发期，不随扩展发布。
- 详情窗口 DOM 自检：把 `tests/card-harness.html` 同样复制到产物目录，`?id=` 后面换 `hp1&view=claim`（普通红包的领取卡片，可领取）、`hp2&view=claim`（抽奖未报名的领取卡片）、`hp3`（已开）、`hp4`（已领完且自己没领到）、`hp5`（后台内存里没有、要等一次只读查询）、`hp6`（`awaiting` 的条目按历史行那样开成详情卡片：铺结论视图，卡片只读、不给任何领取入口）、`missing`（无此条目）各跑一遍；断言窗口尺寸按卡片收紧、卡片挂进宿主且样式先到位、卡片只有一层外壳、合成点击不授权、关掉卡片会关窗口并清掉会话存储里的窗口号，以及**数据回来之前窗口里只有 loading、不铺卡片**（`hp5`）、「还在等点击的那张**封口**卡片不在后台多占一次请求间隔」（`hp1`／`hp2`）、详情卡片照旧补一次只读刷新（`hp3`／`hp4`／`hp6`）。无头下 `screen` 默认 800×600，自检页会先把 `screen.avail*` 顶上去，否则尺寸收紧那几项会被跳过。v0.14.0 起还断言普通红包的开启卡片顶部铺着那条基础信息（`#env-packet-info` 显示「100.00 LDC | 5 个」、贴顶满宽），其余入口（抽奖、只读详情卡片）都藏着它；v0.15.0 起再断言关掉 `view=claim` 的领取卡片会报一条 `hb:card-closed`、关掉只读详情卡片则不报。

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
