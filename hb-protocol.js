/* 红包站协议层：端点、错误文案与结果行。
 *
 * 从脚本版 browser/userscripts/linuxdo-hongbao-code-sidebar.user.js（v2.35.0）的 request /
 * receiptLines / packetOutcome 等函数移植，端点、判定顺序与文案保持一致；
 * 抽奖（lottery）除判定结论外还移植了报名回执与开奖看护的时间窗；站内卡片与
 * 实时参与者列表仍归里程碑 6。
 * 纯函数 + 常量：后台以 importScripts 引入，node 测试直接 require。
 */
'use strict';

(function () {
  const HB_SITE_URL = 'https://hb.unsnow.org/';
  const GAP_BASE_MS = 5000;
  const GAP_EXTRA_MAX_MS = 60000;
  const REQUEST_TIMEOUT_MS = 15000;
  const MAX_HISTORY_ENTRIES = 200;
  const UNCONFIRMED = '领取结果未确认，请到红包站核对记录；不会自动重试';
  const INTERRUPTED_RESULT = '执行被后台回收中断，结果未确认';
  const DRAW_POLL_INTERVAL_MS = 3000;   // 开奖轮询间隔
  const DRAW_WATCH_LIMIT_MS = 120000;   // 过了 draw_at 还等不到开奖就收摊
  const AWAIT_MANUAL_LINE = '等待手动开启';
  const LOTTERY_AWAIT_LINE = '等待手动参与抽选';
  const LOTTERY_JOINED_LINE = '已参与抽选，等待开奖';
  const DRAW_UNCONFIRMED = '开奖结果未确认，请到红包站查看记录';
  const TONES = ['normal', 'success', 'error', 'muted'];

  const PACKET_TYPE_TEXT = {
    equal: '普通红包',
    random: '拼手气红包',
    exclusive: '专属红包',
    lottery: '抽奖红包',
  };
  const CLAIM_FAILURE_TEXT = {
    exhausted: '红包已抢光',
    expired: '红包已过期',
    cancelled: '红包已取消',
    drawn: '抽选已结束',
  };
  const PACKET_STATUS_TITLE = {
    exhausted: '红包已被领取完',
    expired: '红包已过期',
    cancelled: '红包已取消',
    drawn: '抽选已结束',
  };

  const line = (text, tone = 'normal') => ({ text, tone });

  function normalizeLines(raw) {
    if (!Array.isArray(raw)) return null;
    const lines = raw
      .map((item) => ({
        text: item && typeof item.text === 'string' ? item.text : '',
        tone: TONES.includes(item && item.tone) ? item.tone : 'normal',
      }))
      .filter((item) => item.text);
    return lines.length ? lines : null;
  }

  // 结果文案取第一条错误行，没有错误时取最后一行：那是领取结果而不是开头的匹配信息。
  function linesText(lines) {
    const list = lines || [];
    const failure = list.find((item) => item.tone === 'error');
    return (failure || list[list.length - 1] || {}).text || '';
  }

  function errorMessage(data) {
    return data !== null && typeof data === 'object' && !Array.isArray(data) && typeof data.error === 'string'
      ? data.error.trim() : '';
  }

  /* ---------------------------------- 端点 ---------------------------------- */

  const url = (path) => HB_SITE_URL + 'api/hongbao/' + path;
  const sessionUrl = () => HB_SITE_URL + 'api/me';
  // 数字口令走 code/，文本口令走 text-code/，两种字符集在站上是两条路径。
  const queryUrl = (code, charset) => url((charset === 'numeric' ? 'code/' : 'text-code/') + encodeURIComponent(code));
  const grabUrl = (packetId) => url(encodeURIComponent(packetId) + '/grab');
  // 开奖看护按 id 直接读红包本身，脚本版的轮询用的是同一条路径。
  const packetUrl = (packetId) => url(encodeURIComponent(packetId));

  const isLottery = (packet) => packet?.type === 'lottery';

  function validPacket(packet) {
    return Boolean(packet && ['string', 'number'].includes(typeof packet.id) && String(packet.id)
      && typeof packet.creator?.username === 'string' && typeof packet.status === 'string' && !packet.error);
  }

  function hasMatchedPacket(entry) {
    return Boolean(entry?.matched || entry?.packetId
      || (Array.isArray(entry?.lines) && entry.lines.some((item) => item?.tone === 'success'))
      || /^(领取成功|领取失败|已领取|未领取:)/.test(entry?.result || ''));
  }

  // 历史里只需要这些字段，整包（含头像、winners 等）不入库。
  function packetSnapshot(packet) {
    return {
      id: String(packet.id),
      type: typeof packet.type === 'string' ? packet.type : '',
      status: typeof packet.status === 'string' ? packet.status : '',
      wish: typeof packet.wish === 'string' ? packet.wish : '',
      code: typeof packet.code === 'string' ? packet.code : '',
      creator: {
        username: packet.creator?.username || '',
        linuxdo_id: packet.creator?.linuxdo_id ?? null,
      },
      target_username: typeof packet.target_username === 'string' ? packet.target_username : '',
      total_amount: Number.isFinite(Number(packet.total_amount)) ? Number(packet.total_amount) : null,
      count: Number.isFinite(Number(packet.count)) ? Number(packet.count) : null,
      claimed_amount: Number.isFinite(Number(packet.claimed_amount)) ? Number(packet.claimed_amount) : null,
      mine: packet.mine == null ? null : Number(packet.mine),
      joined: Boolean(packet.joined),
      drawn_at: packet.drawn_at ?? null,
      draw_at: Number.isFinite(Number(packet.draw_at)) ? Number(packet.draw_at) : null,
      server_now: Number.isFinite(Number(packet.server_now)) ? Number(packet.server_now) : null,
    };
  }

  function packetKindText(data) {
    if (data.type === 'lottery') {
      return '抽奖红包（' + (data.distribution_type === 'equal' ? '普通' : '拼手气') + '）';
    }
    return PACKET_TYPE_TEXT[data.type] || '红包';
  }

  function packetInfoText(data) {
    const parts = ['发自: ' + data.creator.username, packetKindText(data)];
    const total = Number(data.total_amount);
    if (Number.isFinite(total)) parts.push(total.toFixed(2) + ' LDC');
    const count = Number(data.count);
    if (Number.isFinite(count) && count > 0) {
      parts.push(data.type === 'lottery' ? '抽选 ' + count + ' 人' : count + ' 个');
    }
    return parts.join(' | ');
  }

  // 匹配行的两行都标绿：口令确实匹配到了红包。
  function matchLines(data) {
    const wish = typeof data.wish === 'string' && data.wish.trim() ? data.wish.trim() : '恭喜发财，大吉大利';
    return [line(wish, 'success'), line(packetInfoText(data), 'success')];
  }

  function packetStatusText(status) {
    return { active: '可领取', exhausted: '已领完', expired: '已过期', cancelled: '已取消', drawn: '抽选已结束' }[status] || status;
  }

  /* -------------------------------- 查询结果 -------------------------------- */

  // 一次口令查询的结论：未匹配、失败（需要暂停队列）或拿到了红包。
  function queryOutcome(response) {
    const data = response.response;
    const message = errorMessage(data);
    if (message) return { lines: [line('未匹配: ' + message, 'error')], matched: false };
    if (response.status === 410) return { lines: [line('未匹配: 红包已过期', 'error')], matched: false };
    if (response.status < 200 || response.status >= 300 || !validPacket(data)) {
      return {
        lines: [line('查询失败: HTTP ' + response.status + ' 或响应格式异常，请检查红包站登录与访问验证。', 'error')],
        matched: false,
        pause: true,
      };
    }
    return { matched: true, packet: data };
  }

  /* -------------------------------- 领取结果 -------------------------------- */

  // 报名抽奖不是发放：站点回 { joined, already, packet }，钱要等服务器在 draw_at
  // 开奖；已经关门的抽选回 409 加一句错误文案，那属于正常结论而不是队列故障。
  function lotteryReceiptLines(response, data) {
    const message = errorMessage(data);
    if (message) return { lines: [line('参与失败: ' + message, 'error')], joined: false };
    if (response.status < 200 || response.status >= 300) {
      return { lines: [line('参与结果未确认: HTTP ' + response.status + '，请到红包站核对状态', 'error')], pause: true };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
      return { lines: [line(UNCONFIRMED, 'error')], pause: true };
    }
    const fresh = validPacket(data.packet) ? data.packet : null;
    if (!fresh && !data.joined && !data.already) {
      return { lines: [line(UNCONFIRMED, 'error')], pause: true };
    }
    return {
      lines: [line(data.already ? '已参与过抽选，等待开奖' : LOTTERY_JOINED_LINE, 'success')],
      joined: true,
      packet: fresh,
    };
  }

  // pause 表示这一条不该让队列继续往下跑。
  function claimReceipt(response, packet = null) {
    const data = response.response;
    if (isLottery(packet)) return lotteryReceiptLines(response, data);
    const message = errorMessage(data);
    if (message) return { lines: [line('领取失败: ' + message, 'error')] };
    if (response.status < 200 || response.status >= 300) {
      return { lines: [line('领取失败: HTTP ' + response.status + '，请到红包站核对状态', 'error')], pause: true };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
      return { lines: [line(UNCONFIRMED, 'error')], pause: true };
    }
    if (data.already) {
      return {
        lines: [line('领取失败: 已领取', 'error')],
        already: true,
        amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : undefined,
      };
    }
    const amount = data.amount;
    const numeric = typeof amount === 'number'
      || (typeof amount === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(amount.trim()));
    if (numeric && Number.isFinite(Number(amount))) {
      return { lines: [line('领取成功: +' + Number(amount).toFixed(2) + ' LDC', 'success')], amount: Number(amount) };
    }
    return { lines: [line(UNCONFIRMED, 'error')], pause: true };
  }

  /* ------------------------------- 开奖看护 ------------------------------- */

  // 看护的收摊时刻：draw_at 与 server_now 都来自服务器，本地钟偏不会让看护提前
  // 放弃；过了 draw_at 再等 DRAW_WATCH_LIMIT_MS 仍没开奖才算未确认。
  function watchDeadline(packet, now) {
    const drawAt = Number(packet?.draw_at);
    const serverNow = Number(packet?.server_now);
    const offset = Number.isFinite(serverNow) ? serverNow - now : 0;
    const remaining = Number.isFinite(drawAt) ? Math.max(0, drawAt - (now + offset)) : 0;
    return now + remaining + DRAW_WATCH_LIMIT_MS;
  }

  /* ------------------------------ 不可领取判定 ------------------------------ */

  const isPacketCreator = (packet, user) => user?.linuxdo_id != null && packet.creator?.linuxdo_id != null
    && String(user.linuxdo_id) === String(packet.creator.linuxdo_id);

  const lotteryWinner = (packet, user) => {
    const winners = Array.isArray(packet.winners) ? packet.winners : [];
    const winner = winners.find((item) => item && user?.linuxdo_id != null
      && String(item.linuxdo_id) === String(user.linuxdo_id));
    if (winner) return winner;
    return packet.mine != null ? { amount: packet.mine, payout_status: null } : null;
  };

  const lotteryPayoutText = (status) => (status === 'paid' ? '已到账'
    : (status === 'uncertain' ? '发放待核对' : '等待到账'));

  function lotteryResultLine(packet, user) {
    const winner = lotteryWinner(packet, user);
    if (winner) {
      return line('已中奖: +' + (Number(winner.amount) || 0).toFixed(2)
        + ' LDC（' + lotteryPayoutText(winner.payout_status) + '）', 'success');
    }
    return line(packet.joined ? '未抽中' : '未参与抽选', 'muted');
  }

  // 抽奖红包返回终局结论或 null（还在开奖前，交给里程碑 6 的参与/轮询）。
  function lotteryPacketOutcome(packet, user) {
    if (packet.status === 'active' && !packet.drawn_at) return null;
    const winner = lotteryWinner(packet, user);
    const winners = Array.isArray(packet.winners) ? packet.winners : [];
    const amount = winner ? Number(winner.amount) || 0 : 0;
    const drawn = winners.length + ' / ' + (Number(packet.count) || 0);
    return {
      title: winner ? '抽选结束，你中得 ' + amount.toFixed(2) + ' LDC'
        : (isPacketCreator(packet, user) ? '抽选结束，结果已公示'
          : (packet.joined ? '抽选结束，本次未抽中' : '抽选已结束，未参与')),
      amount,
      detail: winner ? '开奖 ' + drawn + ' 人 · ' + lotteryPayoutText(winner.payout_status)
        : (isPacketCreator(packet, user) ? '未发出的份额已关闭且不会扣款' : '开奖 ' + drawn + ' 人'),
      lines: matchLines(packet).concat(lotteryResultLine(packet, user)),
      drawn: true,
    };
  }

  // 领取相关行统一带「领取失败:」前缀，与脚本版 claimFailed 一致。
  const claimFailed = (reason) => [line('领取失败: ' + reason, 'error')];

  // 拿到匹配红包后的结论：有结果就是这条口令到此为止（不再领取），null 表示可以继续领取。
  function packetOutcome(packet, user) {
    const match = matchLines(packet);
    const terminal = (title, reason, amount = 0) => ({ title, amount, detail: reason, lines: match.concat(claimFailed(reason)) });
    if (packet.type === 'lottery') return lotteryPacketOutcome(packet, user);
    if (packet.mine != null) {
      return {
        ...terminal('你已领取过 ' + packet.creator.username + ' 的红包', '已领取', packet.mine),
        already: true,
        detail: '已存入你的 LDC 账户',
      };
    }
    if (packet.status !== 'active') {
      return {
        ...terminal(PACKET_STATUS_TITLE[packet.status] || '红包当前不可领取',
          '领取失败: ' + (CLAIM_FAILURE_TEXT[packet.status] || '红包当前不可领取')),
        detail: {
          exhausted: '该红包在发出后 24 小时内仍可查看领取记录',
          expired: '超过 24 小时后口令不再生效',
          cancelled: '24 小时内无人领取，口令已失效',
        }[packet.status] || packetStatusText(packet.status),
      };
    }
    if (isPacketCreator(packet, user)) {
      return {
        title: '这是你发出的红包',
        amount: packet.claimed_amount || 0,
        detail: '可以一键复制口令和网址分享给其他人',
        lines: match.concat(line('未领取: 这是你发出的红包', 'muted')),
      };
    }
    if (packet.target_username && user
      && packet.target_username.trim().toLowerCase() !== String(user.username).trim().toLowerCase()) {
      return terminal('这是专属红包', '只有 ' + packet.target_username + ' 可以领取');
    }
    if (!['equal', 'random', 'exclusive'].includes(packet.type)) return terminal('红包类型未知', '红包类型未知，未尝试领取');
    if (!user) return terminal('请先登录红包站', '未确认红包站登录状态，请到红包站登录后再试');
    return null;
  }

  function clampGapExtra(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return Math.min(Math.round(number), GAP_EXTRA_MAX_MS);
  }

  globalThis.HBProtocol = {
    HB_SITE_URL,
    GAP_BASE_MS,
    GAP_EXTRA_MAX_MS,
    REQUEST_TIMEOUT_MS,
    MAX_HISTORY_ENTRIES,
    UNCONFIRMED,
    INTERRUPTED_RESULT,
    DRAW_POLL_INTERVAL_MS,
    DRAW_WATCH_LIMIT_MS,
    AWAIT_MANUAL_LINE,
    LOTTERY_AWAIT_LINE,
    LOTTERY_JOINED_LINE,
    DRAW_UNCONFIRMED,
    line,
    normalizeLines,
    linesText,
    errorMessage,
    sessionUrl,
    queryUrl,
    grabUrl,
    packetUrl,
    isLottery,
    validPacket,
    hasMatchedPacket,
    isPacketCreator,
    lotteryWinner,
    lotteryPayoutText,
    packetSnapshot,
    matchLines,
    packetStatusText,
    queryOutcome,
    claimReceipt,
    watchDeadline,
    packetOutcome,
    clampGapExtra,
  };
})();
