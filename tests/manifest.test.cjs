/* 静态自检：清单结构、引用文件与「不加载远程资源」约束。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// card-window.js 是挂在页面与后台上的 IIFE：给它一个最小沙箱，只为取出卡片尺寸的换算
// （open 要真的碰窗口与存储，这里不碰）。
function loadCardWindow() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'card-window.js'), 'utf8'), context, { filename: 'card-window.js' });
  return sandbox.HBCardWindow;
}

function referencedFiles(spec) {
  const files = [];
  const push = (value) => { if (typeof value === 'string') files.push(value); };
  push(spec.background?.service_worker);
  push(spec.action?.default_popup);
  push(spec.side_panel?.default_path);
  Object.values(spec.icons || {}).forEach(push);
  (spec.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach(push);
    (entry.css || []).forEach(push);
  });
  return files;
}

test('清单是 Chrome MV3 且声明侧边栏与最低版本', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.side_panel?.default_path, '缺少 side_panel.default_path');
  assert.ok(manifest.permissions.includes('sidePanel'), '缺少 sidePanel 权限');
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'sidePanel.open 需要 Chrome 116+');
});

test('版本号符合语义化版本', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('图标是方形 PNG，尺寸与文件名一致', () => {
  // 图标由 tools/make-icons.py 光栅化生成，尺寸写错时工具栏与扩展页会取错资源。
  for (const size of [16, 32, 48, 128]) {
    const png = readFileSync(join(root, 'icons', 'icon' + size + '.png'));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon' + size + '.png 不是 PNG');
    assert.equal(png.readUInt32BE(16), size, 'icon' + size + '.png 宽度不对');
    assert.equal(png.readUInt32BE(20), size, 'icon' + size + '.png 高度不对');
  }
});

test('清单引用的文件都存在', () => {
  const missing = referencedFiles(manifest).filter((file) => !existsSync(join(root, file)));
  assert.deepEqual(missing, []);
});

test('权限只申请 hb.unsnow.org，不绑定任何浏览站点', () => {
  const hosts = manifest.host_permissions || [];
  assert.deepEqual([...hosts].sort(), ['https://hb.unsnow.org/*']);
  assert.equal(manifest.content_scripts, undefined, '面板在浏览器层通用，不注册内容脚本');
});

test('扩展页面不加载远程脚本或样式', () => {
  const pages = ['popup.html', 'sidepanel.html'];
  const remote = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
  for (const page of pages) {
    const html = readFileSync(join(root, page), 'utf8');
    assert.equal(remote.test(html), false, page + ' 引用了远程资源');
  }
});

test('写请求的来源头由声明式规则改写成站点来源', () => {
  // 站点只接受自己那一个 Origin，扩展发出的 POST 带着 chrome-extension://<id>
  // 会被回 403「请求来源不合法」，领取与抽奖报名都发不出去。
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'),
    '缺少 declarativeNetRequestWithHostAccess 权限');
  const resources = manifest.declarative_net_request?.rule_resources || [];
  assert.equal(resources.length, 1, '需要一份静态规则');
  assert.equal(resources[0].enabled, true);
  const ruleFile = join(root, resources[0].path);
  assert.ok(existsSync(ruleFile), '规则文件不存在: ' + resources[0].path);
  const rules = JSON.parse(readFileSync(ruleFile, 'utf8'));
  const rewrite = rules.find((rule) => rule.action?.type === 'modifyHeaders'
    && (rule.action.requestHeaders || []).some((header) => header.header.toLowerCase() === 'origin'
      && header.operation === 'set' && header.value === 'https://hb.unsnow.org'));
  assert.ok(rewrite, '规则必须把 Origin 改写成站点来源');
  assert.deepEqual(rewrite.condition.resourceTypes, ['xmlhttprequest']);
  assert.ok(rules.every((rule) => (rule.condition.urlFilter || '').includes('hb.unsnow.org')), '规则只作用于红包站');
});

test('面板版本号来自清单而不是硬编码', () => {
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  assert.match(panel, /getManifest\(\)\.version/);
  assert.equal(panel.includes("'" + manifest.version + "'"), false, 'panel.js 不应硬编码版本号');
});

test('红包详情卡片随包，头像用站点返回的地址', () => {
  for (const file of ['envelope.js', 'envelope.css', 'card-window.js', 'card.html', 'card.css', 'card.js']) {
    assert.ok(existsSync(join(root, file)), file + ' 缺失');
  }
  // 面板页面只引入 card-window.js（窗口的开合与卡片尺寸换算）；卡片本身只在详情窗口
  // card.html 里渲染，所以面板不必背 envelope.js / envelope.css 那一套。
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    assert.match(html, /src="hb-protocol\.js"/, page + ' 未引入协议层');
    assert.match(html, /src="card-window\.js"/, page + ' 未引入详情窗口');
  }
  const cardPage = readFileSync(join(root, 'card.html'), 'utf8');
  assert.match(cardPage, /src="hb-protocol\.js"/, 'card.html 未引入协议层');
  assert.match(cardPage, /src="card-window\.js"/, 'card.html 未引入详情窗口');
  assert.match(cardPage, /src="envelope\.js"/, 'card.html 未引入红包卡片');
  assert.match(cardPage, /src="card\.js"/, 'card.html 未引入详情窗口脚本');
  assert.match(cardPage, /href="card\.css"/, 'card.html 未引入窗口外框样式');
  // 卡片样式随包，不得出现 @import 或远程 url()。
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  assert.equal(/@import|url\(\s*["']?https?:/i.test(css), false, '信封样式引用了远程资源');
  assert.equal(/@import|url\(\s*["']?https?:/i.test(readFileSync(join(root, 'card.css'), 'utf8')),
    false, '详情窗口样式引用了远程资源');
  // 头像地址照原站 claimAvatarSrc：站点返回什么就用什么（linux.do 的头像在 cdn.ldstatic.com），
  // 拿不到或不是 http(s) 才回落到内联 SVG。协议请求仍然只发 hb.unsnow.org。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  assert.match(js, /HB_SITE_URL/, 'envelope.js 未使用红包站地址');
  assert.match(js, /\['http:', 'https:'\]\.includes\(url\.protocol\)/, '头像不再接受站点返回的地址');
  assert.equal(js.includes('site.origin'), false, '头像又被限制回同源，站点返回的头像会全部变成占位图');
  assert.match(js, /data:image\/svg\+xml/, '缺少内联 SVG 头像兜底');
  // 卡片本体由 createNode() 建出来，markup 里再套一层 .redpacket-envelope
  // 会把 34/24px 内边距、12px 圆角与 520px 定高叠两遍，底部多出一截空红底。
  assert.equal(js.includes('<div class="redpacket-envelope">'), false, 'ENVELOPE_MARKUP 里不该再套一层卡片');
});

test('清单的 CSP 放行站点返回的头像图片', () => {
  // 扩展页的 CSP 由清单写死，img-src 少一项就会在图片发出请求前整批拦掉
  // （控制台报 "violates the following Content Security Policy directive:
  //  img-src 'self' data:"），卡片的 onerror 兜底只会把头像换成占位图，
  // 看着像「头像又没了」，其实是策略没放行。站点返回的头像在论坛 CDN
  // （cdn.ldstatic.com），扩展页拿不到具体域名，只能按 scheme 放行 https:。
  const csp = manifest.content_security_policy?.extension_pages || '';
  const imgSrc = (csp.match(/img-src([^;]*)/) || [, ''])[1].trim().split(/\s+/);
  assert.ok(imgSrc.includes("'self'"), 'CSP 丢了 img-src self');
  assert.ok(imgSrc.includes('data:'), 'CSP 丢了 img-src data:（内联 SVG 头像兜底要用）');
  assert.ok(imgSrc.includes('https:') || imgSrc.some((s) => s.startsWith('https://')),
    'CSP 的 img-src 没放行站点返回的头像地址，头像会被浏览器直接拦掉');
  // 别的口子不能跟着松：脚本仍然只跑随包的，协议请求仍然只发红包站。
  assert.match(csp, /script-src 'self'/, 'script-src 不再是 only-self');
  assert.match(csp, /connect-src 'self' https:\/\/hb\.unsnow\.org/, 'connect-src 越界');
  assert.equal(/script-src[^;]*https?:/.test(csp), false, 'script-src 放行了远程脚本');
});

test('红包卡片不自带焦点圈，确定按钮也不比原站高', () => {
  // 打开卡片原本会 node.focus() 卡片本体，浏览器随即给它套上默认焦点圈，
  // 表现就是「弹出红包窗口后卡片四周多了一圈白边」——原站没这回事。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  assert.equal(/node\.focus\(/.test(js), false, '卡片又被自动聚焦了，会出现原站没有的焦点圈');
  assert.equal(/\.focus\(/.test(js), false, 'envelope.js 里不该有 focus 调用');
  // 兜底：卡片本体显式关掉 outline。
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  const cardBlock = css.slice(css.indexOf('.redpacket-envelope {'), css.indexOf('.redpacket-envelope::before'));
  assert.match(cardBlock, /outline:\s*none/, '卡片本体缺 outline: none 兜底');
  // 原站窄屏只对：.envelope-details 可滚动 + 结果视图不缩；
  // 确定按钮的 min-height 与领取列表的 min-height 原站没有，是我们自己加的，去掉。
  const narrow = css.slice(css.indexOf('@media (max-width: 768px), (max-height: 600px)'));
  assert.equal(narrow.includes('min-height: 55px'), false, '确定按钮又被垫高到 55px，比原站高');
  assert.equal(narrow.includes('.envelope-claims-list { min-height: 48px; }'), false, '领取列表又垫了原站没有的高度');
  const closeRule = css.slice(css.indexOf('.envelope-close-btn {'), css.indexOf('.envelope-close-btn {') + 200);
  assert.match(closeRule, /min-height:\s*38px/, '确定按钮本体应保持原站的 min-height: 38px');
});

test('面板按脚本版侧边栏的结构复刻控件', () => {
  // 这一组是脚本版 ensurePanel() 里逐项对应的控件，缺一个都算没复刻。
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  const parts = [
    ['头部两个开关', /data-switch="batch"/],
    ['文本/数字开关', /data-switch="charset"/],
    ['打开红包站图标按钮', /id="hb-open-site"/],
    ['配置面板的齿轮按钮', /id="hb-config-toggle"/],
    ['收起按钮', /id="hb-close"/],
    ['领取方式开关', /data-switch="claimMode"/],
    ['间隔时间输入', /id="hb-gap"/],
    ['显示方式开关', /data-switch="display"/],
    ['配置面板里的版本号', /id="hb-config-version"/],
    ['登录状态与检查登录', /id="hb-session"/],
    ['历史头文案', /口令历史（/],
    ['作废队列按钮', /id="hb-void-all"/],
    ['清空历史按钮', /id="hb-clear"/],
    ['暂停横幅与恢复执行', /id="hb-resume"/],
    ['点口令填入输入框', /function fillFromHistory/],
    ['口令按钮的提示文案', /点击把这条口令填入输入框/],
    ['红包详情入口', /hb-entry-packet/],
  ];
  for (const [name, pattern] of parts) {
    assert.match(panel, pattern, '缺少' + name);
  }
  // 显示方式把脚本版的悬浮/停靠映射到弹出面板与常显侧边栏。
  assert.match(panel, /display === 'sidebar' \? 'dock' : 'float'/);
  assert.match(panel, /display: next === 'dock' \? 'sidebar' : 'panel'/);
  // 两个外壳分别声明自己的形态。
  assert.match(readFileSync(join(root, 'popup.js'), 'utf8'), /shell: 'popup'/);
  assert.match(readFileSync(join(root, 'sidepanel.js'), 'utf8'), /shell: 'sidebar'/);
});

test('红包卡片保持原尺寸，详情窗口按卡片开窗', () => {
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  // 卡片尺寸沿用原站：320×520 再乘 1.2 倍缩放（常规则显示为 384×624），抽奖卡 420×640。
  assert.match(css, /width: min\(320px, 100%\)/, '卡片不再是原站的 320 基准宽');
  assert.match(css, /height: min\(520px, calc\(\(100dvh - var\(--edge-top\) - var\(--edge-bottom\)\) \/ var\(--envelope-zoom\)\)\)/, '卡片不再是原站的 520 基准高');
  assert.match(css, /width: min\(420px, 100%\)/, '抽奖卡不再是原站的 420 基准宽');
  assert.match(css, /--envelope-zoom: 1\.2;/, '卡片缩放不再是原站的 1.2 倍');
  assert.equal(/--envelope-zoom: \.8/.test(css), false, '详情窗口按卡片开窗，不该再按窗口尺寸缩小卡片');

  // 窗口尺寸由 card-window.js 算出来，这里直接跑一遍真实取值：卡片显示尺寸 + .modal-overlay 的
  // 留白（左右各 20px，上下 20/24px）。开窗时先按外框估尺寸，窗口起来后再用真实差值收紧。
  const geometry = loadCardWindow();
  // 沙箱里造出来的对象原型与这边不同，取成数字再比，免得 deepStrictEqual 拿原型说事。
  const sizeOf = (packet) => {
    const size = geometry.windowSize(packet);
    return [size.width, size.height];
  };
  const outerOf = (packet) => {
    const size = geometry.windowOuterSize(packet);
    return [size.width, size.height];
  };
  assert.deepEqual(sizeOf({ type: 'random' }), [424, 668], '普通红包的窗口视口尺寸不对');
  assert.deepEqual(sizeOf({ type: 'lottery' }), [544, 812], '抽奖红包的窗口视口尺寸不对');
  assert.deepEqual(outerOf({ type: 'random' }), [440, 708], '普通红包的开窗外框尺寸不对');
  assert.deepEqual(outerOf({ type: 'lottery' }), [560, 852], '抽奖红包的开窗外框尺寸不对');

  // 面板自己不再画卡片：不给卡片撑高、不留撑高标记，平时也不留固定高度。
  const panelCss = readFileSync(join(root, 'panel.css'), 'utf8');
  const popup = /body\.hb-popup \{[^}]*\}/.exec(panelCss);
  assert.ok(popup, '面板样式里缺少弹出面板外壳规则');
  assert.equal(/min-height: \d+px/.test(popup[0]), false, '弹出面板又按固定高度留出一块空底');
  assert.equal(panelCss.includes('hb-card-open'), false, 'panel.css 里又出现了卡片撑高面板的规则');
  for (const file of ['panel.js', 'envelope.js', 'card.js']) {
    assert.equal(readFileSync(join(root, file), 'utf8').includes('hb-card-open'), false,
      file + ' 又在给面板打撑高标记');
  }
});

test('历史行的开红包走独立详情窗口', () => {
  // 窗口的开合与卡片尺寸都在 card-window.js：面板点历史行与后台自动弹领取卡片共用同一份。
  const frame = readFileSync(join(root, 'card-window.js'), 'utf8');
  // 开小窗口的地址是 card.html?id=…&view=…（view 决定这一副卡片是等着点一下还是只读详情）。
  assert.match(frame, /const CARD_PAGE = 'card\.html';/, '没有详情页地址');
  assert.match(frame, /api\.runtime\.getURL\(CARD_PAGE\) \+ '\?id=' \+ encodeURIComponent\(id\) \+ '&view=' \+ view/, '开窗地址没有带上红包 id 与卡片种类');
  assert.match(frame, /api\.windows\.create\(\{[\s\S]*?url: cardUrl\(id, want\),[\s\S]*?type: 'popup',[\s\S]*?width: size\.width,[\s\S]*?height: size\.height,/, '没有开详情窗口');
  assert.match(frame, /const size = windowOuterSize\(packet\);/, '开窗尺寸没有按卡片算');
  // 卡片种类各留一个窗口：窗口号记在会话存储里，还活着就复用（同一张卡片同一个红包拉到前面，
  // 换了红包把这一种的旧窗口关掉重开），窗口没了才新开一个。
  assert.match(frame, /const CARD_WINDOW_KEY = 'hb-card-window';/, '缺少详情窗口的记录键');
  assert.match(frame, /api\.windows\.get\(record\.windowId\)/, '没有确认旧窗口是否还活着');
  assert.match(frame, /api\.windows\.remove\(current\.id\)/, '换个红包时没有收掉这一种的旧窗口');
  assert.match(frame, /api\.windows\.update\(windowId, \{ focused: true \}\)/, '没有把已有窗口拉到前面');
  assert.equal(/api\.tabs\.update\(/.test(frame + readFileSync(join(root, 'panel.js'), 'utf8')), false,
    '又用 tabs.update 去改已有窗口的地址了（扩展页能不能这样导航不保证）');
  // 领取卡片与只读详情卡片分开记：领取卡片还等着点击时，点历史行只开/拉详情卡片，不顶掉它。
  assert.match(frame, /records\[VIEW_CLAIM\]\.entryId === id && !claimable\(entry\)/,
    '落定的领取卡片没有被当成详情卡片复用');

  // 面板只负责把详情卡片叫起来：卡片尺寸与窗口复用都在 card-window.js。
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  // 历史行开哪一种卡片由条目状态决定：还等着点一下的（待开启 + 古法 + 抽奖未报名）开领取卡片
  // ——后台只在「这一次刚查到可领」时弹卡，唤醒不再补弹（v0.11.1），历史行是回到那张卡片的
  // 唯一入口；其余条目一律只读详情卡片（脚本版 openHistoryPacket 同视图）。
  assert.match(panel, /const view = cardWindow\.claimable\(entry\) \? 'claim' : 'detail';/, '面板没有按条目状态挑卡片种类');
  assert.match(panel, /cardWindow\.open\(\{ id, entry, packet: entry\.packet, view \}\)/, '面板没有把挑好的卡片种类交给开窗');
  assert.equal(/envelope\.show\(/.test(panel), false, '面板又在自己的页面里画卡片');
  assert.equal(/globalThis\.HBEnvelope/.test(panel), false, '面板又借 envelope.js 算尺寸了');

  // 古法：口令查到可领的红包之后卡片自己弹出来（脚本版 showClaimEnvelope / showLotteryEnvelope）。
  const background = readFileSync(join(root, 'background.js'), 'utf8');
  assert.match(background, /importScripts\('browser-shim\.js', 'code-rules\.js', 'hb-protocol\.js', 'card-window\.js'\)/, '后台没有引入 card-window.js');
  assert.match(background, /cardWindow\.open\(\{ id: entry\.id, entry, packet: entry\.packet, view: 'claim' \}\)/, '后台没有自动弹出领取卡片');

  const card = readFileSync(join(root, 'card.js'), 'utf8');
  assert.match(card, /const params = new URLSearchParams\(location\.search\);/, '详情窗口没有解析 URL 参数');
  assert.match(card, /const entryId = params\.get\('id'\) \|\| '';/, '详情窗口没有从 URL 取红包 id');
  assert.match(card, /envelope\.show\(\{/, '详情窗口没有挂卡片');
  // 领取动作只挂在「等着点一下」的那一副卡片上：URL 带 view=claim、条目仍是待开启、包里没有
  // 报名记录才可领；只读详情卡片不带领取入口（脚本版 openHistoryPacket 同样从不给历史卡片挂
  // 开启按钮）。判据与 card-window.js 共一份，别在两处各写一套。
  assert.match(card, /const claimView = params\.get\('view'\) === 'claim';/, '详情窗口没有按 URL 区分卡片种类');
  assert.match(card, /claimable = claimView && cardWindow\.claimable\(entry\);/, '领取入口的判据没有和开窗那一份共用');
  // 领取与参与照旧回到后台的一次性授权链路：真实点击 → hb:claim（trusted），后台再校验状态。
  assert.match(card, /onWrite: \(\) => send\(\{ type: 'hb:claim', id: entryId, trusted: true \}\)/, '领取与参与没有走后台的一次性授权');
  // 窗口自己认领：起来时登记窗口号与卡片种类（面板与后台据此复用），关掉时只清自己那一条。
  assert.match(card, /cardWindow\.remember\(claimView \? cardWindow\.view\.claim : cardWindow\.view\.detail, \{ windowId, entryId \}\)/,
    '详情窗口没有登记窗口号');
  assert.match(card, /cardWindow\.forget\(claimView \? cardWindow\.view\.claim : cardWindow\.view\.detail, entryId\)/,
    '详情窗口关掉后没有清掉自己那一条记录');
  assert.match(card, /onClose: \(\) => window\.close\(\)/, '关掉卡片没有关窗口');
  // onClose 只认「用户关掉卡片」：show() 换卡片时会先收起上一张，那一次不能把窗口关掉。
  assert.match(readFileSync(join(root, 'envelope.js'), 'utf8'), /closeCard\(replaced\)/, '换卡片与用户关卡片没有区分开');
});

test('红包详情窗口在数据回来之前只显示 loading', () => {
  const cardPage = readFileSync(join(root, 'card.html'), 'utf8');
  const card = readFileSync(join(root, 'card.js'), 'utf8');
  const cardCss = readFileSync(join(root, 'card.css'), 'utf8');
  const background = readFileSync(join(root, 'background.js'), 'utf8');

  // 窗口里先摆一层 loading，卡片的信封样式要等数据到位才挂上去；原生站点也是这个次序
  // （先 await /api/hongbao/<id>，数据回来才把信封模态 active）。
  assert.match(cardPage, /<main id="hb-card-loading" role="status">/, '详情窗口里没有 loading 层');
  assert.match(card, /getElementById\('hb-card-loading'\)/, 'loading 层没有开关');
  assert.match(card, /setLoading\(false\);\n\s+const box = document\.getElementById\('hb-card-error'\)/,
    '报错时没有撤掉 loading');
  assert.match(cardCss, /\n#hb-card-loading \{[^}]*display: flex;/, 'loading 层没有样式');
  assert.match(cardCss, /\n#hb-card-loading\[hidden\] \{/,
    'loading 层的 [hidden] 会被作者的 display 盖掉，得自己写回来');
  assert.match(cardCss, /@media \(prefers-color-scheme: dark\) \{[\s\S]*?#hb-card-loading \{[\s\S]*?\n\}/,
    'loading 层没有暗色一套');

  // 先问后台内存里的整包快照（刚查询、刚领取回执、看护刚轮询过）：命中就一次请求都不发——
  // 那正是「点开要等好几秒」的来源（v0.11.0 起按 id 只读不进限速，省的只是这一趟网络往返）。
  assert.match(card, /readPacket\(packetId, \{ cache: true \}\)/, '详情窗口没有先问后台内存里的整包快照');
  assert.match(background, /cacheOnly: message\.cache === true/, '后台没有 cache-only 读取');
  assert.match(background, /if \(!packet && options\.cacheOnly === true\) return \{ ok: false/,
    'cache-only 读不到内存必须直接回失败，不能偷偷发请求');

  // 内存里没有就只剩一次只读 GET：这一段由 loading 顶着，读不到就退回历史里的快照。
  assert.match(card, /readPacket\(packetId, \{ refresh: true \}\)/, '内存里没有时没有补那次只读查询');
  assert.match(card, /await showCard\(fresh \|\| entry\.packet, user\)/, '读不到详情时没有退回历史快照');
  // 窗口尺寸在铺卡片之前按真实红包收紧：这会儿窗口里还是 loading，缩放看不见。
  assert.match(card, /await fitWindow\(packet\);\n\s+const handle = envelope\.show\(/,
    '窗口没有在铺卡片之前按卡片尺寸收紧');
  // 快照终究是快照：已经在看结论的卡片（领取记录、参与名单）后台补一次只读刷新；还在等点击的
  // 卡片别白跑一趟，免得跟用户紧接着的那一次点击抢同一份请求。
  assert.match(card, /if \(handle && !claimable\)/, '后台补刷新没有区分卡片是否还在等点击');
});

test('卡片显示的内容与红包站卡片一致', () => {
  // 逐条对齐 hb.unsnow.org 的 app.js（v=a0a5b8fa）：showEnvelopeResult / renderEnvelopeClaims /
  // renderLottery。上一版把「不是自己领的红包」的金额抹成 null，看起来和原站就差了那一大块数字。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  // 原站 showEnvelopeResult 对已领完/已过期/已取消/专属红包传的就是 0，卡片照显 0.00 LDC。
  assert.equal(/amount: owned \? Number\(packet\.mine\) : null/.test(js), false,
    '又按「是不是自己领的」把金额抹掉了');
  assert.match(js, /const outcome = P\.packetOutcome\(packet, state\.user\);\n\s*if \(outcome\) return outcome;/,
    '历史条目的结论没有直接照用 packetOutcome 的金额');
  // 刷新领取记录时接着原来的滚动位置（原站 renderEnvelopeClaims 的 scrollTop）。
  assert.match(js, /const scrollTop = list\.scrollTop;/, '刷新领取记录时没有记住滚动位置');
  assert.match(js, /list\.scrollTop = scrollTop;/, '刷新领取记录后没有恢复滚动位置');
  // 抽奖卡片：已报名显示「已参与抽选」而不是把按钮藏掉，空名单与「自己发的」文案照原站。
  assert.match(js, /join\.textContent = state\.busy \? '正在参与…' : packet\.joined \? '已参与抽选' : '参与抽选';/,
    '抽奖按钮的文案/禁用态没有按原站');
  assert.equal(/join\.hidden = state\.viewOnly \|\| ended \|\| creator \|\| Boolean\(packet\.joined\)/.test(js), false,
    '已报名的抽奖又把按钮藏回去了（原站是禁用 + 「已参与抽选」）');
  assert.match(js, /'无人参与，红包已关闭，未扣款。'/, '中奖公示为空的文案没有按原站');
  assert.match(js, /'这是你发出的红包，参与名单实时更新'/, '自己发出的抽奖红包文案没有按原站');
  assert.match(js, /'连接恢复中，正在定时更新'/, '抽奖卡片掉线时的提示没有按原站');

  // 卡面上不该有原站没有的「×」：原站卡片只有「开」/「确定」/「关闭」，关窗口交给窗口自己。
  assert.equal(js.includes('envelope-dismiss'), false, '卡片又加回了原站没有的关闭按钮');
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  assert.equal(css.includes('envelope-dismiss'), false, '样式里还留着「×」的规则');
  // 遮罩用原站那一层（rgba(24,24,27,.5)，暗色主题再深一档），不是脚本版弹在论坛上的 PhotoSwipe 黑底。
  assert.match(css, /background: rgba\(24, 24, 27, 0\.5\);/, '遮罩不是原站的 rgba(24, 24, 27, 0.5)');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{[\s\S]*?\.modal-overlay \{\n\s*background: rgba\(0, 0, 0, 0\.62\);/, '暗色主题的遮罩没有按原站加深');
  assert.equal(/background: #000;\n\s*opacity: 0\.8;/.test(css), false, '遮罩又用回脚本版的黑底 0.8');
  // 结果视图的合成层要与原站那段入场动画留下的层一致，文字抗锯齿才逐像素相同。
  assert.match(css, /\.envelope-details \{[\s\S]*?will-change: opacity;/, '结果视图没有补齐原站那层合成');
  // 详情窗口的外框底色用原站页面底色，那层半透明遮罩落下来才是同一圈灰。
  const cardCss = readFileSync(join(root, 'card.css'), 'utf8');
  assert.match(cardCss, /background: #ffffff;/, '详情窗口底色不是原站页面底色');
  assert.match(cardCss, /@media \(prefers-color-scheme: dark\) \{[\s\S]*?background: #18181b;/, '详情窗口暗色底没有对齐原站');
});

test('自己发出的红包那句文案与红包站一致', () => {
  // 原站 showEnvelopeResult('这是你发出的红包', …, '可以一键复制口令和网址分享给其他人')。
  const protocol = readFileSync(join(root, 'hb-protocol.js'), 'utf8');
  assert.match(protocol, /detail: '可以一键复制口令和网址分享给其他人'/, '自己发出的红包文案没有对齐原站');
});

test('面板里没有脚本版侧边栏之外的常驻提示区', () => {
  // 脚本版 ensurePanel() 没有全局提示行，v0.8.2 把面板里那行（#hb-hint）整个删掉：
  // 领取/参与/查询的结果写在历史行里，队列出错走暂停横幅，登录状态写在配置面板。
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  const css = readFileSync(join(root, 'panel.css'), 'utf8');
  assert.equal(panel.includes('hb-hint'), false, 'panel.js 里又出现了底部提示行');
  assert.equal(css.includes('hb-hint'), false, 'panel.css 里又出现了提示行样式');
  assert.equal(panel.includes('面板在任意网站都可用'), false, '又加回了常驻的提示文案');
  assert.equal(panel.includes('面板固定在浏览器侧边栏'), false, '又加回了常驻的提示文案');
  // 空历史也照脚本版空着，不写占位文案。
  assert.equal(panel.includes('队列为空'), false, '又加回了空历史的占位文案');
  assert.equal(panel.includes('hb-empty'), false, 'panel.js 里又出现了空历史占位元素');
  assert.equal(css.includes('hb-empty'), false, 'panel.css 里又出现了空历史占位样式');
  // 没有行级出口的问题只记控制台；登录检查写在配置面板那一行。
  assert.match(panel, /console\.warn\('\[红包口令面板\] '/, '缺少控制台告警出口');
  assert.match(panel, /text\('#hb-session-text'/, '登录检查结果没有写进配置面板');
});

test('卡片样式先到位再画，避免无样式一闪', () => {
  // <link> 是异步的：暗色主题下卡片会先按 UA 默认样式画一帧，就是「底部按钮先亮一下
  // 再变暗」。改成先把同包 css 读成 constructable stylesheet，开卡片时同步挂上。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  assert.match(js, /runtime\?\.getURL\?\.\(STYLE_HREF\)/, '没有读同包的卡片样式');
  assert.match(js, /new CSSStyleSheet\(\)/, '没有把样式读成 constructable stylesheet');
  assert.match(js, /shadowRoot\.adoptedStyleSheets = \[sheet\]/, '开卡片时没有同步挂上预读的样式表');
  assert.match(js, /link\.addEventListener\('load', markStyled, \{ once: true \}\)/, '兜底路径没有等样式到位');
  assert.match(js, /host\.style\.visibility = 'hidden'/, '兜底路径没有先藏住没样式的卡片');
  assert.match(js, /^\s*loadStyles\(\);/m, '面板加载时没有预读样式');
  assert.ok(existsSync(join(root, 'envelope.css')), '卡片样式不再是随包的一份文件');
});

test('显示方式是用户的持久选择，点图标去哪由它决定', () => {
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  const background = readFileSync(join(root, 'background.js'), 'utf8');
  // 侧边栏不再把眼前的形态写回设置：手动关掉侧边栏不该改掉这个选择，下次点图标还是它。
  assert.equal(/patchSettings\(\{ display: 'sidebar' \}\)/.test(panel), false,
    '侧边栏还在把显示方式改成停靠');
  assert.equal(/pagehide/.test(panel), false, '侧边栏收起时还在改写显示方式');
  assert.equal(/markDocked/.test(panel), false, '还留着「跟着实际形态走」的对照表');
  // 开关本身还在：弹出面板里切停靠要拉起侧边栏并收起自己。
  assert.match(panel, /patchSettings\(\{ display: next === 'dock' \? 'sidebar' : 'panel' \}\)/);
  assert.match(panel, /if \(isPopup\) \{\n          openSidebar\(\);/);
  // 图标点击的去向只有后台改得了：停靠＝图标交给侧边栏开合并清掉 popup，悬浮＝弹出 popup。
  assert.match(background, /sidePanel\?\.setPanelBehavior\?\.\(\{ openPanelOnActionClick: docked \}\)/,
    '没有把图标点击交给侧边栏');
  assert.match(background, /action\?\.setPopup\?\.\(\{ popup: docked \? '' : 'popup\.html' \}\)/,
    '没有按显示方式开关 popup');
  assert.match(background, /await syncActionMode\(\);/, '设置变更后没有同步图标行为');
  assert.match(background, /^syncActionMode\(\)\.catch/m, 'worker 起来时没有重放图标行为');
  // popup 仍然声明在清单里：悬浮模式回到它就是靠它。
  assert.match(readFileSync(join(root, 'manifest.json'), 'utf8'), /"default_popup": "popup\.html"/);
});

test('打开面板就把焦点放进输入框', () => {
  // 弹出面板与常显侧边栏一打开就能直接打字，省掉一次点击；形态变化（侧边栏被藏起来再
  // 露出来）也补一次，但正在别处编辑时不抢焦点。
  const panel = readFileSync(join(root, 'panel.js'), 'utf8');
  assert.match(panel, /const focusField = \(\) => \{/, '没有放焦点的动作');
  assert.match(panel, /refresh\(\)\.finally\(focusField\)/, '第一次渲染完没有把焦点放进输入框');
  assert.match(panel, /const field = activeField\(\);/, '没有按当前模式选单个输入框或批量文本域');
  // 侧边栏是 Chrome 晚一步把焦点交过来的（还可能先落在面板里别的元素上），放一次不保险。
  assert.match(panel, /for \(const delay of \[60, 200, 450, 900, 1600\]\)/, '没盖住侧边栏交焦点的窗口期');
  assert.match(panel, /window\.addEventListener\('focus', \(\) => \{ focusField\(\); \}\)/, '窗口拿到焦点时没有补一次');
  assert.match(panel, /document\.addEventListener\('visibilitychange'/, '侧边栏再露出来时没有补一次焦点');
  assert.match(panel, /if \(document\.visibilityState === 'visible'\)/, '露出来时没有补一次焦点');
  // 用户自己动过键盘鼠标就不插手（焦点是他选的）；面板重新露出来时清掉这个记录，重新按刚打开处理。
  assert.match(panel, /document\.addEventListener\('pointerdown', noteTouch, true\)/, '没有记录用户是否自己动过');
  assert.match(panel, /if \(userTouched\) return false;/, '用户动过之后还在抢焦点');
  assert.match(panel, /userTouched = false;\s*\n\s*if \(document\.visibilityState === 'visible'\) focusField\(\);/,
    '重新露出来时没有清掉「用户动过」的记录并补一次焦点');
});

test('关掉红包卡片后面板还能点', () => {
  // 宿主是固定定位、盖住整个面板的一层，关卡片时不撤掉就会吞掉面板的全部点击
  // （回归 bug：弹出红包再关闭，面板点不动，重开面板才恢复）。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  assert.match(js, /if \(host\) host\.remove\(\)/, '关闭卡片时没有撤掉宿主层');
  assert.match(js, /host = null;\s*\n\s*overlay = null;/, '关闭卡片后没有清掉宿主与遮罩引用');
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  const host = Array.from(css.matchAll(/:host \{[^}]*\}/g), (match) => match[0])
    .find((block) => block.includes('all: initial'));
  assert.ok(host, '样式里缺少 :host 基础规则');
  assert.match(host, /pointer-events: none/, '宿主层没有让开指针事件');
});

test('历史行红包图标与脚本版同色（主体红 + 封口金）', () => {
  // 脚本版同处写死 color:#dc2626、:hover #b91c1c，第三段 path 写死 fill="#eab308"
  // （LINUXDO.md：主体红色且中间圆点金色）。面板照搬这三个站点色，不套面板自身的界面红金——
  // 这枚字形是站点品牌图形，套上面板配色会比脚本版淡一截。v0.7.0 复刻成插件时把它换成了
  // hb-packet-seal 这个 class、却没补上对应样式，历史行那颗图标一度整颗变成纯红，
  // 扩展图标也跟着丢了金色封口，这里守住这条。
  const panelJs = readFileSync(join(root, 'panel.js'), 'utf8');
  assert.match(panelJs, /class="hb-packet-seal"/, 'panel.js 没有标记出中间那枚封口盘');
  const panelCss = readFileSync(join(root, 'panel.css'), 'utf8');
  const block = (selector) => {
    const found = panelCss.match(new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*\\}'));
    assert.ok(found, 'panel.css 里找不到 ' + selector);
    return found[0];
  };
  assert.match(block('.hb-entry-packet'), /color:\s*#dc2626\b/, '历史行红包主体不是脚本版那颗红');
  assert.match(block('.hb-entry-packet:hover'), /color:\s*#b91c1c\b/, '历史行红包悬停色与脚本版不一致');
  assert.match(block('.hb-entry-packet .hb-packet-seal'), /fill:\s*#eab308\b/, '封口盘不是脚本版那颗金');
  const tool = readFileSync(join(root, 'tools', 'make-icons.py'), 'utf8');
  assert.match(tool, /RED = \(220, 38, 38, 255\)/, '图标生成脚本的主体红与脚本版不一致');
  assert.match(tool, /GOLD = \(234, 179, 8, 255\)/, '图标生成脚本的封口金与脚本版不一致');
  assert.match(tool, /SEAL_PATHS = PACKET_ICON_PATHS\[2:\]/, '图标生成脚本没有把封口盘单独画一层');
});

test('面板配色改用脚本版的站点调色板（亮/暗两套），弹窗宽度收窄', () => {
  // v0.9.11：面板原先是一套莫兰迪配色，跟脚本版（直接吃 linux.do 的 --primary / --tertiary /
  // --danger …）不是一个观感。扩展页没有站点可继承，就把 linux.do 亮色方案
  // （color_definitions_scheme_-1）与暗色方案（_105）里的色值写死进 panel.css，
  // 并按 prefers-color-scheme 分两套——脚本版跟着站点主题走，插件得自己分。
  const css = readFileSync(join(root, 'panel.css'), 'utf8');
  // 注释里会讲到「以前是 560px」「以前用莫兰迪红」这类历史，比较色值前先把注释剥掉。
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const value = (block, name) => {
    const found = new RegExp(name + ':\\s*([^;]+);').exec(block);
    assert.ok(found, 'panel.css 里缺少 ' + name);
    return found[1].trim();
  };
  const light = /:root \{([^}]*)\}/.exec(css);
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css);
  assert.ok(light, 'panel.css 里缺少 :root 调色板');
  assert.ok(dark, '面板没有按系统主题分暗色一套');
  assert.match(css, /color-scheme: light dark;/, '没有声明 color-scheme，表单控件与滚动条不会跟着换主题');

  // 亮色：--secondary / --primary / --tertiary / --danger / --success …
  assert.equal(value(light[1], '--hb-bg'), '#ffffff', '亮色面板底色不是 linux.do 的 --secondary');
  assert.equal(value(light[1], '--hb-card'), '#f8f8f8', '亮色次级容器底不是 --primary-very-low');
  assert.equal(value(light[1], '--hb-border'), '#e9e9e9', '亮色分隔线不是 --primary-low');
  assert.equal(value(light[1], '--hb-border-strong'), '#bdbdbd', '亮色控件描边不是 --primary-low-mid');
  assert.equal(value(light[1], '--hb-text'), '#222222', '亮色正文不是 --primary');
  assert.equal(value(light[1], '--hb-text-secondary'), '#919191', '亮色次要文字不是 --primary-medium');
  assert.equal(value(light[1], '--hb-accent'), '#0088cc', '亮色强调色不是 --tertiary');
  assert.equal(value(light[1], '--hb-danger'), '#c80001', '亮色失败色不是 --danger');
  assert.equal(value(light[1], '--hb-danger-low'), '#ffe0e0', '亮色失败底色不是 --danger-low');
  assert.equal(value(light[1], '--hb-success'), '#009900', '亮色成功色不是 --success');

  // 暗色：同一批语义换 _105 方案的值。
  assert.equal(value(dark[1], '--hb-bg'), '#222222', '暗色面板底色不是 linux.do 暗色 --secondary');
  assert.equal(value(dark[1], '--hb-border'), '#313131', '暗色分隔线不是暗色 --primary-low');
  assert.equal(value(dark[1], '--hb-text'), '#dddddd', '暗色正文不是暗色 --primary');
  assert.equal(value(dark[1], '--hb-accent'), '#099dd7', '暗色强调色不是暗色 --tertiary');
  assert.equal(value(dark[1], '--hb-danger'), '#e45735', '暗色失败色不是暗色 --danger');
  assert.equal(value(dark[1], '--hb-success'), '#1ca551', '暗色成功色不是暗色 --success');

  // 旧调色板的色值一个都不该留下，配套的变量名也不该再被引用——变量删了而规则还在，
  // 浏览器会把整条声明当无效值丢掉，颜色会静默变成继承色。
  for (const hex of ['#f3efe8', '#fbfaf7', '#e5e0d7', '#45413b', '#9a917f', '#b3aa99',
    '#c05c5c', '#c98f4b', '#7e9a7a', '#fdfaf6']) {
    assert.equal(rules.includes(hex), false, 'panel.css 里还留着旧调色板的 ' + hex);
  }
  for (const name of ['--hb-red', '--hb-gold', '--hb-green']) {
    assert.equal(rules.includes('var(' + name + ')'), false, 'panel.css 里还在用已删掉的 ' + name);
  }

  // 与脚本版逐条对齐的几处：选中段是站点蓝底白字、暂停横幅是 danger 药丸、
  // 「拆红包」照脚本版写死的站点红（不跟主题走）。
  assert.match(css, /\.hb-switch-option\.is-active \{[^}]*background: var\(--hb-accent\);/,
    '选中的开关段不是站点的 --tertiary 底');
  assert.match(css, /\.hb-paused \{[^}]*background: var\(--hb-danger-low\);[^}]*color: var\(--hb-danger\);/,
    '暂停横幅不是脚本版那枚 danger-low 药丸');
  assert.match(css, /\.hb-submit \{[^}]*background: var\(--hb-site-red\)/,
    '「拆红包」不是脚本版写死的站点红');

  // 面板宽度按内容收窄：卡片从 v0.9.7 起在独立窗口里，面板再不需要 560px。
  const popup = /body\.hb-popup \{[^}]*\}/.exec(css);
  assert.ok(popup, '面板样式里缺少弹出面板外壳规则');
  assert.match(popup[0], /width: 400px;/, '弹出面板宽度没有收窄到 400px');
  assert.equal(/560px/.test(rules), false, 'panel.css 里还留着为卡片铺开的 560px');
});
