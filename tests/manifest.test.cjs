/* 静态自检：清单结构、引用文件与「不加载远程资源」约束。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

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

test('红包详情卡片随包，头像只从红包站来源加载', () => {
  for (const file of ['envelope.js', 'envelope.css']) {
    assert.ok(existsSync(join(root, file)), file + ' 缺失');
  }
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    assert.match(html, /src="hb-protocol\.js"/, page + ' 未引入协议层');
    assert.match(html, /src="envelope\.js"/, page + ' 未引入红包卡片');
  }
  // 卡片样式随包，不得出现 @import 或远程 url()。
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  assert.equal(/@import|url\(\s*["']?https?:/i.test(css), false, '信封样式引用了远程资源');
  // 头像是卡片里唯一的远程图形，必须锁死在红包站来源，其余用内联 SVG。
  const js = readFileSync(join(root, 'envelope.js'), 'utf8');
  assert.match(js, /HB_SITE_URL/, 'envelope.js 未使用红包站地址');
  assert.match(js, /url\.origin !== site\.origin/, '头像来源没有做同源限制');
  assert.match(js, /data:image\/svg\+xml/, '缺少内联 SVG 头像兜底');
  // 卡片本体由 createNode() 建出来，markup 里再套一层 .redpacket-envelope
  // 会把 34/24px 内边距、12px 圆角与 520px 定高叠两遍，底部多出一截空红底。
  assert.equal(js.includes('<div class="redpacket-envelope">'), false, 'ENVELOPE_MARKUP 里不该再套一层卡片');
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

test('红包卡片保持原尺寸，弹出面板按卡片留位', () => {
  const css = readFileSync(join(root, 'envelope.css'), 'utf8');
  // 卡片尺寸沿用原站：320×520 再乘 1.2 倍缩放（常规则显示为 384×624），抽奖卡 420×640。
  assert.match(css, /width: min\(320px, 100%\)/, '卡片不再是原站的 320 基准宽');
  assert.match(css, /height: min\(520px, calc\(\(100dvh - var\(--edge-top\) - var\(--edge-bottom\)\) \/ var\(--envelope-zoom\)\)\)/, '卡片不再是原站的 520 基准高');
  assert.match(css, /width: min\(420px, 100%\)/, '抽奖卡不再是原站的 420 基准宽');
  assert.match(css, /--envelope-zoom: 1\.2;/, '卡片缩放不再是原站的 1.2 倍');
  assert.equal(/--envelope-zoom: \.8/.test(css), false, '面板里不该按窗口尺寸缩小卡片，窗口该加大');
  // 窗口不够大就加大面板：宽度要容下最大的卡片（504 + 两侧 20px 边距）。
  const panel = readFileSync(join(root, 'panel.css'), 'utf8');
  const popup = /body\.hb-popup \{[^}]*\}/.exec(panel);
  assert.ok(popup, '面板样式里缺少弹出面板外壳规则');
  const width = /width: (\d+)px/.exec(popup[0]);
  assert.ok(width && Number(width[1]) >= 544, '弹出面板宽度放不下原尺寸的卡片：' + (width && width[1]));
  const height = /min-height: (\d+)px/.exec(popup[0]);
  assert.ok(height && Number(height[1]) >= 600, '弹出面板高度放不下原尺寸的卡片：' + (height && height[1]));
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
