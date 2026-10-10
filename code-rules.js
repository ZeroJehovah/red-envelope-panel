/* 口令清洗与校验规则。
 *
 * 从脚本版 browser/userscripts/linuxdo-hongbao-code-sidebar.user.js（v2.35.0）原样移植，
 * 保持逐字符一致的行为：单个模式丢弃非法字符、批量模式只按换行分行、粘贴分享文案时只取其中的口令。
 * 纯字符串处理，不碰 DOM 与存储：面板页面以 <script src> 引入，node 测试直接 require。
 * 规则里保留了脚本版的站点标识匹配（credit.linux.do、LDC 红包），属输入格式兼容，说明见 docs/AGENTS.md。
 */
'use strict';

(function () {
  // 文本口令 6-18 个字符，数字口令恰好 8 位。
  const TEXT_MIN_LENGTH = 6;
  const TEXT_MAX_LENGTH = 18;
  const NUMERIC_LENGTH = 8;

  /* ------------------------------- 字符清洗 ------------------------------- */

  function isAllowedCodeCharacter(character) {
    return /^[\p{Script=Han}A-Za-z0-9]$/u.test(character);
  }

  function isBatchLineBreak(character) {
    return character === '\n';
  }

  function isAllowedCharacterFor(character, charset) {
    return charset === 'numeric' ? /^[0-9]$/.test(character) : isAllowedCodeCharacter(character);
  }

  function codeLengthLimit(charset) {
    return charset === 'numeric' ? NUMERIC_LENGTH : TEXT_MAX_LENGTH;
  }

  // 单个模式丢弃所有非法字符（与 hb.unsnow.org 的文本口令增强一致）；批量模式只把换行当分隔符，
  // 同一行里的空格与标点就地删除而不会多出一行，即粘贴多少行就对应多少条口令。
  function sanitizeValue(value, batch, charset) {
    const limit = codeLengthLimit(charset);
    let output = '';
    let currentLength = 0;
    for (const character of Array.from(String(value === null || value === undefined ? '' : value))) {
      if (isAllowedCharacterFor(character, charset)) {
        if (currentLength >= limit) continue;
        output += character;
        currentLength += 1;
        continue;
      }
      if (!batch || !isBatchLineBreak(character)) continue;
      if (output && !output.endsWith('\n')) output += '\n';
      currentLength = 0;
    }
    return output;
  }

  /* ---------------------------- 分享文案取词 ---------------------------- */
  // 粘贴的分享文案只保留其中携带的口令，例如：
  //   我向你分享了一个LDC红包，打开 hb.unsnow.org ，输入口令 11775521 领取
  // （站点会把域名和口令用反引号括起来）。命中条件刻意收窄：文案要么点出站点名，
  // 要么同时出现「口令」与「领取」，因此只是碰巧含「口令」二字的文本口令不会被改写。
  const SHARE_SITE_HINT = /hb\s*[.。]\s*unsnow\s*[.。]\s*org|credit\s*[.。]\s*linux\s*[.。]\s*do|LDC\s*红包/i;
  // 口令通常被反引号、引号或括号包着；这些字符写成码点，方便下面两条规则阅读。
  const SHARE_KEYWORD_PATTERN =
    /口令\s*(?:是|为)?\s*[:：]?\s*[\u0060\u0022\u0027\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3010\u3011\uff08\uff09()]?\s*([^\u0060\u0022\u0027\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3010\u3011\uff08\uff09()\s,，。;；、!！?？:：]{1,40})/gu;
  const SHARE_QUOTED_PATTERN =
    /[\u0060\u0022\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3010\u3011]([^\u0060\u0022\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3010\u3011\n]{1,40})[\u0060\u0022\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3010\u3011]/gu;
  const SHARE_TRAILING_NOISE = /(?:领取|领红包|自取|速来|快来|拿去|拿走|手慢无|先到先得|即可领取)+$/gu;
  const SHARE_NOISE_LINE = /^[\s,，。;；、!！~～:：]*?(?:领取|领红包|自取|速来|快来|拿去|拿走|手慢无|先到先得)[\s,，。;；、!！~～]*$/u;
  const SHARE_URL_LIKE = /^(?:https?:\/\/|www\.)[^\s]+$/i;
  const SHARE_HOST_LIKE = /^(?:[\w-]+[.。])+[a-z]{2,}(?:\/\S*)?$/i;

  function isSharedText(text) {
    if (SHARE_SITE_HINT.test(text)) return true;
    return text.includes('口令') && text.includes('领取');
  }

  function cleanShareToken(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(SHARE_TRAILING_NOISE, '')
      .replace(/^[-–—·=]+|[-–—·=]+$/gu, '')
      .trim();
  }

  // 一行分享文案携带的口令；不是分享文案、或取不到符合当前字符集的口令时给空字符串。
  function extractSharedCode(line, charset) {
    const text = String(line === null || line === undefined ? '' : line);
    if (!isSharedText(text)) return '';
    const candidates = [];
    const collect = (value) => {
      const token = cleanShareToken(value);
      if (!token || SHARE_URL_LIKE.test(token) || SHARE_HOST_LIKE.test(token)) return;
      const code = sanitizeValue(token, false, charset);
      if (code) candidates.push(code);
    };
    let match;
    SHARE_KEYWORD_PATTERN.lastIndex = 0;
    while ((match = SHARE_KEYWORD_PATTERN.exec(text)) !== null) collect(match[1]);
    SHARE_QUOTED_PATTERN.lastIndex = 0;
    while ((match = SHARE_QUOTED_PATTERN.exec(text)) !== null) collect(match[1]);
    if (charset === 'numeric') {
      const naked = /(?:^|\D)(\d{8})(?!\d)/.exec(text);
      if (naked) candidates.push(naked[1]);
    }
    // 只有当前字符集认可的口令才会替换粘贴内容，其余仍走普通字符清洗，不凭空造口令。
    return candidates.find((code) => !validateCode(code, charset)) || '';
  }

  // 分享文案可能把口令放在下一行；只有紧邻的下一非空行本身就是合法口令时才采用。
  function carriedSharedCode(lines, index, charset) {
    for (let next = index + 1; next < lines.length; next += 1) {
      const raw = lines[next].trim();
      if (!raw) continue;
      const code = sanitizeValue(raw, false, charset);
      return code === raw && !validateCode(code, charset) ? { code, index: next } : null;
    }
    return null;
  }

  // 单个模式只留一条口令；批量模式逐行处理，混合粘贴分享文案与裸口令也能各自成活。
  // 返回 null 表示没有取到口令，调用方应保持原样。
  function sharedPasteValue(pastedText, batch, charset) {
    const source = String(pastedText === null || pastedText === undefined ? '' : pastedText);
    const lines = source.split(/\r?\n/);
    if (!batch) return extractSharedCode(lines.join(' '), charset) || null;
    let replaced = false;
    const output = [];
    for (let index = 0; index < lines.length; index += 1) {
      const code = extractSharedCode(lines[index], charset);
      if (code) {
        output.push(code);
        replaced = true;
        continue;
      }
      const carried = isSharedText(lines[index]) ? carriedSharedCode(lines, index, charset) : null;
      if (carried) {
        output.push(carried.code);
        replaced = true;
        index = carried.index;
        continue;
      }
      // 分享文案的口令已被取走，紧跟其后的那条「领取」行一并丢掉。
      if (replaced && SHARE_NOISE_LINE.test(lines[index])) continue;
      output.push(lines[index]);
    }
    return replaced ? output.join('\n') : null;
  }

  /* ------------------------------- 校验与解析 ------------------------------- */

  function utf16Length(value) {
    return Array.from(value).reduce((length, character) => length + character.length, 0);
  }

  function parseCodes(rawValue, charset, batch) {
    const limit = codeLengthLimit(charset);
    const parts = batch ? String(rawValue || '').split('\n') : [String(rawValue || '')];
    return parts
      .map((part) => Array.from(part.trim()).slice(0, limit).join(''))
      .filter(Boolean)
      .map((code) => ({ code, charset }));
  }

  function validateCode(code, charset) {
    if (charset === 'numeric') {
      return /^[0-9]{8}$/.test(code) ? '' : '数字口令须为恰好 8 位半角数字（0–9）';
    }
    const characters = Array.from(code);
    if (characters.length < TEXT_MIN_LENGTH) return '文字口令不足 6 个字符';
    if (characters.length > TEXT_MAX_LENGTH) return '文字口令超过 18 个字符';
    return characters.every(isAllowedCodeCharacter) ? '' : '口令只能包含数字、汉字或英文字母';
  }

  function isNumericOnly(value) {
    return /^[0-9]+$/.test(String(value || '').trim());
  }

  // 切到数字模式时只有整条都是数字的草稿能留下，批量模式逐行判断。
  function keepNumericOnly(value) {
    return isNumericOnly(value) ? Array.from(value.trim()).slice(0, NUMERIC_LENGTH).join('') : '';
  }

  globalThis.HBCodes = {
    TEXT_MIN_LENGTH,
    TEXT_MAX_LENGTH,
    NUMERIC_LENGTH,
    isAllowedCodeCharacter,
    isBatchLineBreak,
    isAllowedCharacterFor,
    codeLengthLimit,
    sanitizeValue,
    isSharedText,
    cleanShareToken,
    extractSharedCode,
    sharedPasteValue,
    utf16Length,
    parseCodes,
    validateCode,
    isNumericOnly,
    keepNumericOnly,
  };
})();
