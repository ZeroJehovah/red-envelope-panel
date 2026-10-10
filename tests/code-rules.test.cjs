/* 口令规则自检：字符清洗、分享文案取词与校验，用例取自脚本版同类场景。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

require('../code-rules.js');
const codes = globalThis.HBCodes;
const root = join(__dirname, '..');

const TICK = String.fromCharCode(96); // 分享文案把域名和口令括起来的反引号
const share = (code) => '我向你分享了一个LDC红包，打开 ' + TICK + 'hb.unsnow.org' + TICK
  + ' ，输入口令 ' + TICK + code + TICK + ' 领取';

test('单个模式丢弃非法字符并按字符集截断', () => {
  assert.equal(codes.sanitizeValue('  新年 快乐发财', false, 'text'), '新年快乐发财');
  assert.equal(codes.sanitizeValue('abc!@#123def', false, 'text'), 'abc123def');
  assert.equal(codes.sanitizeValue('a'.repeat(25), false, 'text').length, codes.TEXT_MAX_LENGTH);
  assert.equal(codes.sanitizeValue('1177-5521x', false, 'numeric'), '11775521');
  assert.equal(codes.sanitizeValue('1177552199', false, 'numeric'), '11775521');
  assert.equal(codes.sanitizeValue('汉字在新年', false, 'numeric'), '');
});

test('批量模式只按换行分行，行内空格与标点就地删除', () => {
  assert.equal(codes.sanitizeValue(' 新年 快乐发财 \n 87654321 ', true, 'text'), '新年快乐发财\n87654321');
  // 行尾换行与脚本版一样保留，空行由 parseCodes 丢弃。
  assert.equal(codes.sanitizeValue('新年快乐发财\n', true, 'text'), '新年快乐发财\n');
  assert.equal(codes.sanitizeValue('11775521\n87654321\n', true, 'numeric'), '11775521\n87654321\n');
});

test('分享文案只留下它携带的口令', () => {
  assert.equal(codes.extractSharedCode(share('新年快乐发财'), 'text'), '新年快乐发财');
  assert.equal(codes.extractSharedCode(share('11775521'), 'text'), '11775521');
  assert.equal(codes.extractSharedCode(share('11775521'), 'numeric'), '11775521');
  assert.equal(codes.extractSharedCode('打开 hb.unsnow.org 的红包，输入口令：87654321，领取', 'numeric'), '87654321');
});

test('含「口令」二字的普通文本口诀不被改写', () => {
  assert.equal(codes.extractSharedCode('口令红包大吉大利', 'text'), '');
  // 站点名与域名本身不是口令。
  assert.equal(codes.extractSharedCode('我向你分享了一个LDC红包，打开 ' + TICK + 'hb.unsnow.org' + TICK + ' 领取', 'text'), '');
});

test('单个模式粘贴普通文本保持原样（交给普通清洗）', () => {
  assert.equal(codes.sharedPasteValue('  新年 快乐发财', false, 'text'), null);
  assert.equal(codes.sharedPasteValue(share('11775521'), false, 'text'), '11775521');
});

test('批量模式混合粘贴分享文案与裸口令，各自成活', () => {
  assert.equal(
    codes.sharedPasteValue(share('11775521') + '\n' + share('87654321'), true, 'numeric'),
    '11775521\n87654321',
  );
  assert.equal(
    codes.sharedPasteValue(share('新年快乐发财') + '\n' + share('11775521') + '\nabc123', true, 'text'),
    '新年快乐发财\n11775521\nabc123',
  );
});

test('口令被分享文案拆到下一行时重新拼回', () => {
  assert.equal(
    codes.sharedPasteValue('我向你分享了一个LDC红包，打开 hb.unsnow.org ，输入口令\n新年快乐发财\n领取', true, 'text'),
    '新年快乐发财',
  );
});

test('解析草稿：单个取整条，批量逐行并丢弃空行', () => {
  assert.deepEqual(codes.parseCodes(' 新年快乐发财 ', 'text', false), [{ code: '新年快乐发财', charset: 'text' }]);
  assert.deepEqual(
    codes.parseCodes('11775521\n\n87654321\n', 'numeric', true),
    [{ code: '11775521', charset: 'numeric' }, { code: '87654321', charset: 'numeric' }],
  );
  assert.equal(codes.parseCodes('a'.repeat(20), 'text', false)[0].code.length, codes.TEXT_MAX_LENGTH);
  assert.deepEqual(codes.parseCodes('   ', 'text', false), []);
});

test('校验文案沿用脚本版', () => {
  assert.equal(codes.validateCode('12345678', 'numeric'), '');
  assert.equal(codes.validateCode('1234567', 'numeric'), '数字口令须为恰好 8 位半角数字（0–9）');
  assert.equal(codes.validateCode('abc12', 'text'), '文字口令不足 6 个字符');
  assert.equal(codes.validateCode('a'.repeat(19), 'text'), '文字口令超过 18 个字符');
  assert.equal(codes.validateCode('abc 123', 'text'), '口令只能包含数字、汉字或英文字母');
});

test('切到数字模式时只留下整条都是数字的草稿', () => {
  assert.equal(codes.keepNumericOnly(' 11775521 '), '11775521');
  assert.equal(codes.keepNumericOnly('1177552199'), '11775521');
  assert.equal(codes.keepNumericOnly('abc123'), '');
  assert.equal(codes.isNumericOnly('11775521'), true);
});

test('两个面板页面都在面板脚本之前引入口令规则', () => {
  for (const page of ['popup.html', 'sidepanel.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    const rules = html.indexOf('src="code-rules.js"');
    const panel = html.indexOf('src="panel.js"');
    assert.ok(rules > -1, page + ' 没有引入 code-rules.js');
    assert.ok(rules < panel, page + ' 的引入顺序不对');
  }
});
