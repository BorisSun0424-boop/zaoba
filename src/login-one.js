#!/usr/bin/env node
/**
 * 单个平台登录助手（给网页控制台的「去登录」按钮调用）。
 *
 * 用法：node src/login-one.js <platformId>
 * 行为：弹出可见浏览器 → 你扫码/输手机号 → 检测到登录成功 → 自动保存登录态并退出
 *
 * 退出码：0 成功 / 2 超时 / 3 该平台需要客户端登录（不能走网页） / 1 出错
 */
import { launchContext } from './browser.js';
import { loadConfig, resolveAdapters } from './config.js';
import { pageText, detectLogin } from './dom.js';
import { createLogger } from './logger.js';
import { sleep } from './util.js';

const MAX_MINUTES = 10;
// 打开页面后先给前端留出渲染时间再开始判定，
// 否则页面还是白屏/骨架屏时，"没有登录入口"会被误读成"已登录"
const JUDGE_DELAY_MS = 6000;
const logger = createLogger('login');

/** 各平台"登录成功"的判定方式 */
const DETECT = {
  minimax: async (page) => {
    const text = await pageText(page).catch(() => '');
    const loginForm = /微信扫码登录|获取验证码|请输入您的手机号|立即登录/.test(text);
    const logged = /每日签到|签到得|新建任务|插件·技能|MiniMax\d{3,}|用户\d{3,}/.test(text);
    return { ok: !loginForm && logged, why: loginForm ? 'login-form' : logged ? 'user-ui' : 'unknown' };
  },
  // 智谱：不能看 chatglm_token！
  // 实测（2026-10-31）：未登录的游客也会拿到一整套 token
  //   chatglm_token(421B) / chatglm_refresh_token / chatglm_user_id 都存在，
  // 用 Boolean(chatglm_token) 判定会导致"一打开就判成功、4 秒后自动关窗"，
  // 用户根本来不及扫码。只能看页面本身：是否还有可见的「登录」入口。
  zhipu: async (page) => {
    const text = await pageText(page).catch(() => '');
    const r = await detectLogin(page, text).catch(() => ({ needLogin: true, reason: 'detect-error' }));
    if (r.needLogin) return { ok: false, why: r.reason };
    // 兜底：游客态的首页一定挂着拉新文案（登录送积分好礼 等），登录后消失
    if (/登录送积分好礼|登录送好礼|登录领/.test(text)) return { ok: false, why: 'guest-promo' };
    return { ok: true, why: 'no-login-entry' };
  },
};

async function detectDefault(page) {
  const text = await pageText(page).catch(() => '');
  const stillLogin = /扫码登录|短信验证码|验证码登录|请输入手机号|请先登录/.test(text);
  return { ok: !stillLogin, why: stillLogin ? 'login-form' : 'no-login-text' };
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('用法: node src/login-one.js <platformId>');
    process.exit(1);
  }

  const cfg = loadConfig();
  const list = resolveAdapters(cfg, { includeDisabled: true, only: [id] });
  const adapter = list[0];
  if (!adapter) {
    console.error(`找不到平台: ${id}`);
    process.exit(1);
  }

  // 显式 type 优先：MiniMax 虽然是 standalone（自己开浏览器），但它属于网页类
  const pc = cfg.platforms[id] || {};
  const explicitType = pc.type;
  const isClient =
    explicitType === 'client' ||
    (explicitType !== 'web' && (adapter.clientApp || pc.app || id === 'workbuddy'));
  if (isClient) {
    console.log(`CLIENT:${adapter.name}`);
    process.exit(3);
  }

  const url = adapter.loginUrl || adapter.homepage;
  if (!url) {
    console.error('该平台没有配置登录地址');
    process.exit(1);
  }

  // 启动浏览器可能卡住（例如 channel 指向的系统浏览器不响应），必须设超时
  const ctx = await Promise.race([
    launchContext(cfg, { headless: false, logger }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('浏览器启动超时（60 秒）——可能是 config.json 里的 channel 指向了无法启动的浏览器，可删掉 channel 字段重试')), 60000),
    ),
  ]);
  const page = await ctx.newPage();
  logger.info(`打开 ${adapter.name} 登录页: ${url}`);

  // 用户手动关掉窗口时，留一点时间让 cookie 落盘再退出（否则刚登录完就关窗会丢登录态），
  // 然后立刻退出，避免控制台一直显示"登录窗口已打开"
  let closedByUser = false;
  const onClose = (who) => {
    if (closedByUser) return;
    closedByUser = true;
    logger.warn(`登录窗口已关闭（${who}），结束本次登录`);
    // 300ms 太短：Chrome 关闭时 cookie 库可能还没 commit，扫码登录会白扫
    setTimeout(() => process.exit(2), 1200);
  };
  page.on('close', () => onClose('page'));
  ctx.on('close', () => onClose('context'));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.bringToFront().catch(() => null);

    // 尽量自动点开登录弹窗
    for (const sel of ['button:has-text("登录")', 'button:has-text("登录 / 注册")', 'text=登录']) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click({ timeout: 4000 });
          logger.info('已尝试打开登录弹窗，请扫码或输入手机号');
          break;
        }
      } catch {
        /* 换下一个 */
      }
    }

    const detector = DETECT[id] || detectDefault;
    const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
    const judgeFrom = Date.now() + JUDGE_DELAY_MS;
    let lastWhy = '';
    while (Date.now() < deadline) {
      await sleep(2500);
      if (closedByUser || page.isClosed()) {
        logger.warn('登录窗口已被关闭，结束本次登录');
        await sleep(1200); // 关窗前可能刚完成登录，留时间让 cookie 落盘
        await ctx.close().catch(() => null);
        process.exit(2);
      }
      // 页面刚打开时还没渲染出登录入口，过早判定会误判为"已登录"
      if (Date.now() < judgeFrom) continue;
      const r = await detector(page, ctx).catch(() => ({ ok: false, why: 'err' }));
      if (r.ok) {
        await sleep(2000); // 让 cookie 落盘
        logger.info(`✅ ${adapter.name} 登录成功，登录态已保存`);
        await ctx.close();
        process.exit(0);
      }
      if (r.why !== lastWhy) {
        logger.info(`等待登录中（${r.why}）…`);
        lastWhy = r.why;
      }
    }

    // 超时前再确认一次（有些页面登录后会跳转，可能刚好错过检测）
    const lastCheck = await detector(page, ctx).catch(() => ({ ok: false }));
    if (lastCheck.ok) {
      logger.info(`✅ ${adapter.name} 登录成功（超时前最终确认）`);
      await ctx.close();
      process.exit(0);
    }
    logger.warn(`${MAX_MINUTES} 分钟内未检测到登录成功`);
    await ctx.close().catch(() => null);
    process.exit(2);
  } catch (e) {
    logger.error(`登录过程出错: ${e.message}`);
    await ctx.close().catch(() => null);
    process.exit(1);
  }
}

main();
