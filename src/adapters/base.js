import { gotoSettled, pageText, clickByKeywords, findClickables, detectLogin, dismissOverlays, classifyOutcome } from '../dom.js';
import { sleep } from '../util.js';

/**
 * 适配器约定（所有平台共用的契约）：
 *
 * id            唯一标识，也是 config.platforms 的 key
 * name          中文名，用于报告
 * homepage      首页
 * entryUrls     依次尝试的签到入口（先首页，再活动页）
 * loginUrl      登录命令里打开的地址
 * keywords      候选签到按钮文案（命中即视为可点击目标）
 * doneKeywords  出现即判定"今天已完成"
 * api           可选，直接请求签到接口（若平台是纯前端按钮则留空）
 * notes         给用户看的说明：入口在哪、已知坑
 * custom        可选，覆盖默认自动点击流程
 */
export function defineAdapter(spec) {
  return {
    homepage: '',
    entryUrls: [],
    loginUrl: spec.homepage,
    keywords: ['签到', '立即签到', '打卡', '领取', '领'],
    doneKeywords: [],
    api: null,
    notes: '',
    custom: null,
    enabledByDefault: true,
    ...spec,
  };
}

/**
 * 默认签到流程：
 *   1. 依次打开 entryUrls，等到页面基本可交互
 *   2. 判定是否被踢回登录页 → 需要用户重新登录
 *   3. 扫已经签到的迹象（幂等：跑两次不会出问题）
 *   4. 找按钮 → 点击 → 判定结果
 */
export async function genericCheckin(adapter, page, ctx, logger, cfg = {}) {
  const urls = adapter.entryUrls.length ? adapter.entryUrls : [adapter.homepage];
  const lastReason = [];

  for (const url of urls) {
    let text = '';
    try {
      await gotoSettled(page, url, logger, { settle: cfg.settle || 1800 });
      // 先关掉挡路的隐私协议/活动弹窗，再重新读页面文本
      await dismissOverlays(page, logger);
      text = await pageText(page);
    } catch (e) {
      lastReason.push(`${url} 打开失败: ${e.message.split('\n')[0]}`);
      logger.warn(`${url} 打开失败: ${e.message.split('\n')[0]}`);
      continue;
    }

    const login = await detectLogin(page, text);
    if (login.needLogin) {
      logger.warn(`${login.reason} → 需要重新登录`);
      return { status: 'needs_login', detail: login.reason, url: page.url() };
    }

    // 已完成判定（幂等保护）
    // 注意：不能只凭文案判定——页面上常有属于别的活动的同款文案
    // （例如豆包工作的「已领取」属于"选择工作领域领奖励"，而每日签到按钮其实还在）。
    // 真正可信的信号是「签到入口按钮已经消失」。
    const doneHit = adapter.doneKeywords.find((k) => text.includes(k));
    const cls = classifyOutcome(text);
    if (doneHit || cls.already) {
      const entryLeft = (adapter.keywords || ['签到']).length
        ? await findClickables(page, adapter.keywords || ['签到'])
        : [];
      if (entryLeft.length === 0) {
        logger.ok(`今天已完成（页面显示"${doneHit || '已签到/已领取'}"且签到入口已消失）`);
        return { status: 'already', detail: doneHit || '页面显示今日已完成', url: page.url() };
      }
      logger?.step?.(
        `页面出现了「${doneHit || '已完成'}」但签到入口仍在，判定为今天还没签，继续`,
      );
    }

    // 平台自定义逻辑优先
    if (typeof adapter.custom === 'function') {
      const r = await adapter.custom({ page, logger, cfg, url, text });
      if (r && r.status) return { ...r, url: page.url() };
    }

    const res = await clickByKeywords(page, adapter.keywords, logger, { label: adapter.name });
    const out = res.outcome || {};
    await sleep(600);

    if (out.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）`, url: page.url() };
    if (out.success) return { status: 'success', detail: `点击「${res.text}」后出现成功提示`, url: page.url() };
    if (out.fail) return { status: 'failed', detail: `点击「${res.text}」后出现失败提示`, url: page.url() };
    if (res.clicked) return { status: 'uncertain', detail: `已点击「${res.text}」，但没读到明确结果，请看截图`, url: page.url() };

    lastReason.push(`${url} 页面上找不到签到按钮`);
    logger.warn(`${url} 页面上找不到签到按钮`);
  }

  // 兜底：页面里只有「登录」字样、没有已登录标志、也找不到签到按钮
  // → 基本可以确定是登录态过期，而不是这个站没有签到功能
  try {
    const tail = await pageText(page, 4000);
    const weakLogin = /登录/.test(tail) && !/(退出登录|切换账号|个人中心|我的主页|账户设置)/.test(tail);
    if (weakLogin) {
      return { status: 'needs_login', detail: '找不到签到按钮，且页面上只有「登录」入口，判定为登录态失效', url: page.url() };
    }
  } catch {
    /* ignore */
  }

  return { status: 'not_found', detail: lastReason.join('；') || '没有找到签到入口', url: page.url() };
}
