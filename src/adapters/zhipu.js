import { createHash, randomBytes } from 'node:crypto';
import { defineAdapter } from './base.js';
import { pageText, gotoSettled } from '../dom.js';

/**
 * 智谱清言（chatglm.cn）—— 本工具里唯一"真正全自动"的平台。
 *
 * 调研结论（2026-10，实时探测确认）：
 *   - 签到不是按钮，而是页面加载时前端自动调用的接口，所以不需要找 DOM、不需要点击
 *   - POST /chatglm/member-api/member/daily_login_score  body {}
 *       返回 status=10001 表示今日已领（幂等，可以盲调）
 *   - 签名可在本地算：X-Sign = md5(`${ts}-${nonce}-<secret>`)  ← 这是关键，不需要抓包
 *   - 登录态是 cookie: chatglm_token（约 24h）+ chatglm_refresh_token（约 50 天）
 *     页面加载时前端会自动调 /chatglm/user-api/user/refresh 续期，所以我们每次
 *     先打开一次首页，token 就自动刷新了，不用自己实现续期逻辑
 *   - 设备 ID 在 localStorage['chatglm-deid']，必须与 token 里的 device_id 一致
 *
 * 实测（未登录）：400 {"status":40003,"message":"bad request(40003)"}
 */

const APP_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';
const API_CHECKIN = '/chatglm/member-api/member/daily_login_score';
const API_MEMBER = '/chatglm/member-api/member/member_info';

/**
 * 生成智谱要求的签名头。
 *
 * 注意两点（2026-10-31 实测踩坑）：
 *  1) 时间戳不是原样的毫秒串。官方 j() 会把 13 位时间戳的**倒数第二位**替换成校验位：
 *       校验位 = (各位数字之和 − 倒数第二位) % 10
 *     再拿改写后的串参与 md5，所以这里的 ts 必须做同样处理。
 *  2) 光有签名头还不够，接口还要求 `Authorization: Bearer <chatglm_token>`。
 *     缺这个头时服务端统一返回 400 40003 bad request(40003)，
 *     看起来像"未登录"，实际是"缺请求头"——排查时极易误判。
 */
export function buildZhipuHeaders(deviceId, { appVersion = '2.0.7' } = {}) {
  const ts = signedTimestamp();
  const nonce = randomBytes(16).toString('hex');
  const sign = createHash('md5').update(`${ts}-${nonce}-${APP_SECRET}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'App-Name': 'chatglm',
    'X-App-Platform': 'pc',
    'X-App-Version': appVersion,
    'X-Device-Id': deviceId,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Sign': sign,
  };
}

/** 复刻官方 j()：13 位毫秒串，倒数第二位替换为「各位和(不含该位) % 10」 */
function signedTimestamp() {
  const raw = String(Date.now());
  const digits = raw.split('').map(Number);
  const sum = digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2];
  return raw.slice(0, raw.length - 2) + (sum % 10) + raw.slice(-1);
}

export default defineAdapter({
  id: 'zhipu',
  name: '智谱清言',
  homepage: 'https://chatglm.cn/',
  entryUrls: ['https://chatglm.cn/'],
  keywords: ['签到', '每日登录', '领取'],
  doneKeywords: ['今日登录积分已到账', '今日已领取'],
  enabledByDefault: true,
  notes:
    '唯一支持纯接口自动签到的平台，默认启用。单账号每日一次，幂等安全；token 24h 过期但打开首页会自动续期。',

  custom: async ({ page, logger }) => {
    // 1) 打开首页：让前端自己完成 token 续期，同时确保当前 origin 是 chatglm.cn（同源才带 cookie）
    await gotoSettled(page, 'https://chatglm.cn/', logger, { settle: 1500 });
    await pageText(page, 2000);

    // 2) 取设备 ID（必须与 token 内 device_id 一致，否则 40003）
    const deid = await page
      .evaluate(() => localStorage.getItem('chatglm-deid') || '')
      .catch(() => '');
    if (!deid) logger.warn('未读到 chatglm-deid，使用随机设备 ID（可能被判为陌生设备）');
    const deviceId = deid || crypto.randomUUID();
    const headers = buildZhipuHeaders(deviceId);

    // 3) 在页面上下文里发请求：cookie、origin、UA 全部天然正确，不需要手工拼 Cookie 头
    //    但 Authorization 必须手工加：官方的 chatglm_token 同时以 Bearer 形式发给业务接口，
    //    只带 cookie 会被判 40003（错误信息说"未登录"，其实是缺头）
    const res = await page.evaluate(
      async ({ headers, apiCheckin, apiMember }) => {
        const m = document.cookie.match(/(?:^|;\s*)chatglm_token=([^;]+)/);
        const token = m ? m[1] : '';
        if (!token) return { noToken: true };

        const withAuth = { ...headers, Authorization: `Bearer ${token}` };
        const call = async (url, method = 'POST') => {
          try {
            const r = await fetch(url, {
              method,
              headers: withAuth,
              body: method === 'POST' ? '{}' : undefined,
              credentials: 'include',
            });
            const text = await r.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* 非 JSON 响应 */
            }
            return { http: r.status, json, text: text.slice(0, 300) };
          } catch (e) {
            return { http: 0, error: String(e && e.message ? e.message : e) };
          }
        };
        return {
          checkin: await call(apiCheckin, 'POST'),
          member: await call(apiMember, 'GET'),
        };
      },
      { headers, apiCheckin: API_CHECKIN, apiMember: API_MEMBER },
    );

    if (res.noToken) {
      return { status: 'needs_login', detail: '页面里没有 chatglm_token，请点卡片上的「去登录」重新扫码' };
    }

    const ck = res.checkin || {};
    const body = ck.json || {};
    const code = String(body.status ?? body.code ?? '');
    logger.step(`签到接口 HTTP ${ck.http} code=${code || '-'} msg=${body.message || body.msg || ''}`);

    // 未登录 / token 失效
    if (ck.http === 401 || code === '40003' || code === '40102' || code === '401') {
      return { status: 'needs_login', detail: `签到接口返回未登录(${code || ck.http})，请点卡片上的「去登录」（或运行 npm run login）` };
    }

    // 今日已领（幂等，正常情况）
    if (code === '10001') {
      const pts = readPoints(res.member);
      return { status: 'already', detail: `今日登录积分已领取${pts !== null ? `，当前积分 ${pts}` : ''}`, meta: { credits: pts } };
    }

    // 成功
    if (ck.http === 200 && (code === '10000' || code === '0' || code === '')) {
      const pts = readPoints(res.member);
      const gained = body.result?.score ?? body.result?.left_score ?? null;
      const gainTxt = gained !== null && gained !== undefined ? `+${Number(gained) / (Number(gained) > 1000 ? 100 : 1)}` : '';
      return {
        status: 'success',
        detail: `签到成功${gainTxt ? ` ${gainTxt} 积分` : ''}${pts !== null ? `，当前积分 ${pts}` : ''}`,
        meta: { credits: pts, todayCredit: gained !== null ? Number(gained) : undefined },
      };
    }

    return {
      status: 'failed',
      detail: `签到接口返回 HTTP ${ck.http} ${body.message || body.msg || ck.text || ''}`.trim(),
    };
  },
});

/** member_info 的 left_score 是 1/100 精度 */
function readPoints(member) {
  try {
    const v = member?.json?.result?.left_score ?? member?.json?.result?.data?.left_score;
    if (v === undefined || v === null) return null;
    const n = Number(v) / 100;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
