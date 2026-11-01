import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import platform from '../platform.js';
import { sleep } from '../util.js';
import { findClickables, clickByKeywords, pageText, classifyOutcome, detectLogin, screenshot } from '../dom.js';

/**
 * 通用"接管桌面客户端"适配器。
 *
 * 适用对象：Electron 或 Chromium 壳（CEF）的客户端。这类客户端的界面本质是网页，
 * 只要能用调试端口连进去，就能：
 *   1. 在页面里执行 JS（直接调它自己的前端接口，带登录态）
 *   2. 或者像网页一样找按钮点（DOM 策略）
 *   3. 还能用客户端自己的登录态新开标签页访问它的网页版
 *
 * 不适用：原生 AppKit 客户端（只能 AppleScript 点 UI，需要辅助功能权限，脆弱）、手机 App。
 *
 * config.json 里的写法（platforms 下任意 key，带 app 字段就会走这里）：
 *
 *   "doubao": {
 *     "enabled": false,
 *     "type": "client",
 *     "name": "豆包",
 *     "app": "/Applications/Doubao.app",
 *     "port": 9445,
 *     "cdpMode": "arg",                    // "arg" = --remote-debugging-port；"env" = 专用环境变量
 *     "pageUrlMatch": "doubao-chat",       // 选哪个页面去操作
 *     "keywords": ["签到", "领取"],
 *     "doneKeywords": ["已签到", "明天再来"],
 *     "jsEval": "",                        // 可选：在页面里执行的 JS 表达式，优先于 DOM 策略
 *     "openUrl": "",                       // 可选：用客户端登录态新开这个网址再操作
 *     "quitAfterLaunch": true
 *   }
 */

async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function asynIsRunning(execPath) {
  return platform.isProcessRunning(execPath);
}

export function resolveExecutable(pc) {
  const explicit = pc.app || pc.bin;
  const fromCandidates = platform.pickAppPath(pc.appCandidates || []);
  // 优先用实际存在的路径；配置里写死的路径不存在时退回候选列表
  const candidate =
    (explicit && fs.existsSync(explicit) ? explicit : null) ||
    (pc.bin && fs.existsSync(pc.bin) ? pc.bin : null) ||
    fromCandidates ||
    explicit;
  if (!candidate) throw new Error('客户端平台缺少 app/bin 配置');
  return platform.resolveExecutable(candidate);
}

async function gracefulQuitApp(pc, execPath, logger) {
  const appName = pc.quitAppName || String(pc.name || '').replace(/\s+/g, '');
  return platform.gracefulQuit({ appName, execPath, logger });
}

async function quitApp(pid, execPath, logger) {
  try {
    await platform.gracefulQuit({ execPath, logger });
    logger?.step('已关闭客户端');
  } catch (e) {
    logger?.warn(`关闭客户端失败（忽略）: ${String(e.message).split('\n')[0]}`);
  }
}

export async function runClientApp(pc, { logger, cfg, shotDir, shotName, dryRun = false } = {}) {
  const port = Number(pc.port || 9445);
  const appOrBin = pc.app || pc.bin;
  if (appOrBin && platform.isMacOS && !fs.existsSync(appOrBin)) {
    return {
      status: 'not_installed',
      detail: `没有找到客户端 ${appOrBin}。装上并登录后，把 config.json 里的 app/app路径 改对再启用`,
    };
  }
  const execPath = resolveExecutable(pc);
  const quitAfter = pc.quitAfterLaunch !== false;
  const timeoutMs = Number(pc.launchTimeoutMs || 60000);

  // 1) 端口已在监听 → 直接接管；否则按配置拉起客户端
  let version = await cdpVersion(port);
  let launchedPid = null;
  const wasRunningAtStart = await asynIsRunning(execPath);

  // 拉起客户端所需的环境与参数（后面的重启重试也要用，所以在 if 外面准备好）
  const launchEnv = { ...process.env };
  delete launchEnv.ELECTRON_RUN_AS_NODE; // Electron 客户端会因此以 Node 模式启动并秒退
  delete launchEnv.NODE_OPTIONS;
  const launchArgs = [];
  if ((pc.cdpMode || 'arg') === 'env') {
    launchEnv[pc.cdpEnv || 'WORKBUDDY_REMOTE_DEBUGGING_PORT'] = String(port);
  } else {
    launchArgs.push(`--remote-debugging-port=${port}`);
  }
  const launchOnce = async () => {
    const child = spawn(execPath, launchArgs, { detached: true, stdio: 'ignore', env: launchEnv });
    child.unref();
    launchedPid = child.pid;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await cdpVersion(port);
      if (v) return v;
      await sleep(1200);
    }
    return null;
  };

  if (!version) {
    if (wasRunningAtStart) {
      if (!pc.autoRestart) {
        return {
          status: 'needs_manual',
          detail: `客户端正在运行但没有开启调试端口 ${port}。请先退出它，再重跑（或在 config 里设 autoRestart: true）`,
        };
      }
      // autoRestart：优雅退出后带调试端口重启，签完保持运行（恢复你的使用状态）
      logger?.info(`${pc.name || '客户端'} 在运行但无调试端口，自动重启一次以开启接管`);
      await gracefulQuitApp(pc, execPath, logger);
    }

    logger?.info(`启动 ${pc.name || '客户端'}（端口 ${port}）`);
    version = await launchOnce();

    // Electron 客户端有单实例锁：上一个实例还没退干净时，新进程会把参数转发给旧实例
    // 然后自己退出，调试端口永远开不起来。这种情况再强制重启一次基本都能成功。
    if (!version && (await asynIsRunning(execPath))) {
      logger?.warn(`端口未就绪但 ${pc.name || '客户端'} 进程仍在，可能是单实例锁，强制退出后重试一次`);
      await gracefulQuitApp(pc, execPath, logger);
      await sleep(1500);
      logger?.info(`重试启动 ${pc.name || '客户端'}（端口 ${port}）`);
      version = await launchOnce();
    }

    if (!version) {
      await quitApp(launchedPid, execPath, logger);
      return { status: 'error', detail: `客户端已启动但调试端口 ${port} 没响应（${timeoutMs / 1000}s 超时）` };
    }
    logger?.info(`CDP 就绪: ${version.Browser}`);
  } else {
    logger?.step(`检测到调试端口 ${port} 已就绪，直接接管`);
  }

  // 2) 连进去
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  } catch (e) {
    if (launchedPid) await quitApp(launchedPid, execPath, logger);
    return { status: 'error', detail: `连接 CDP 失败: ${String(e.message).split('\n')[0]}` };
  }

  let page;

  try {
    // 3) 选页面（必要时用客户端登录态新开一个网页）
    let pages = browser.contexts().flatMap((c) => c.pages());
    logger?.step(`发现 ${pages.length} 个页面`);

    if (pc.openUrl) {
      page = await browser.contexts()[0].newPage();
      await page.goto(pc.openUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // 任务/活动面板是异步渲染的，尽量等它稳定
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
      await sleep(2500);
    } else {
      // 冷启动的客户端刚连上 CDP 时往往一个页面都还没有，
      // 这时直接判"没找到可操作的页面"会误杀（实测刚拉起的 Trae 需要 5~15 秒才有窗口）
      for (let i = 0; i < 20 && !pages.length; i++) {
        await sleep(1500);
        pages = browser.contexts().flatMap((c) => c.pages());
        if (i === 3) logger?.step('还没出现页面，继续等待客户端渲染…');
      }
      page = (pc.pageUrlMatch && pages.find((p) => p.url().includes(pc.pageUrlMatch))) || pages[0];

      // 连得上、但一个可操作窗口都没有：典型是"窗口被关掉、进程还挂在后台"，
      // 这时 CDP 里只剩客户端自己的后台页（如 Trae 的 solo-lite），Playwright 认不出来。
      // 重启一次客户端，工作区窗口才会重新建出来。
      if (!page) {
        logger?.warn(`${pc.name || '客户端'} 只有后台页、没有可操作窗口，重启一次再试`);
        await browser.close().catch(() => null);
        await gracefulQuitApp(pc, execPath, logger);
        await sleep(1200);
        version = await launchOnce();
        if (!version) {
          return { status: 'error', detail: `重启 ${pc.name || '客户端'} 后调试端口 ${port} 仍未就绪` };
        }
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
        pages = browser.contexts().flatMap((c) => c.pages());
        for (let i = 0; i < 20 && !pages.length; i++) {
          await sleep(1500);
          pages = browser.contexts().flatMap((c) => c.pages());
        }
        page = (pc.pageUrlMatch && pages.find((p) => p.url().includes(pc.pageUrlMatch))) || pages[0];
      }

      if (!page) {
        return {
          status: 'error',
          detail: `没找到可操作的页面（重启客户端后仍只有 ${pages.length} 个后台窗口，请手动打开 ${pc.name || '客户端'} 窗口后重试）`,
        };
      }
    }

    // 3.4) 等界面真正渲染完（冷启动的 VS Code 系客户端常常还是空白）
    let preText = await pageText(page).catch(() => '');
    for (let i = 0; i < 14 && preText.length < 120; i++) {
      logger?.step(`界面还没渲染完（${preText.length} 字符），等待…`);
      await sleep(1500);
      preText = await pageText(page).catch(() => '');
    }

    // 3.5) 有些客户端的签到入口藏在账户菜单里，先点开再判断状态
    //      注意：部分客户端是"切换式"菜单，已打开时再点会关掉 → 先用 menuOpenTexts 判断
    const menuOpenTexts = pc.menuOpenTexts || [];
    let menuAlreadyOpen = false;
    if (menuOpenTexts.length) {
      const cur = await pageText(page);
      menuAlreadyOpen = menuOpenTexts.some((t) => cur.includes(t));
      if (menuAlreadyOpen) logger?.step('前置菜单已是打开状态，跳过点击');
    }

    if (Array.isArray(pc.beforeClickSelectors) && pc.beforeClickSelectors.length && !menuAlreadyOpen) {
      let clickedMenu = false;
      for (let attempt = 0; attempt < 3 && !clickedMenu; attempt++) {
        for (const sel of pc.beforeClickSelectors) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 2000 })) {
              logger?.step(`打开前置菜单: ${sel}`);
              try {
                await loc.click({ timeout: 4000 });
              } catch (clickErr) {
                // locator.click 会做可点击性检查（visible/stable/receives events），
                // 被透明悬浮层挡住的按钮会因此超时失败（实测 Trae CN 改版后的账号按钮）。
                // 退化为坐标点击（page.mouse 不做遮挡检查），能穿透遮挡层点到目标。
                const box = await loc.boundingBox();
                if (!box) throw clickErr;
                const x = Math.round(box.x + box.width / 2);
                const y = Math.round(box.y + box.height / 2);
                logger?.step(`点击被遮挡，改用坐标点击 (${x},${y})`);
                await page.mouse.click(x, y);
              }
              await sleep(1800);
              clickedMenu = true;
              break;
            }
          } catch {
            /* 换下一个选择器 */
          }
        }
        if (!clickedMenu) await sleep(2500);
      }
      if (!clickedMenu) logger?.warn('前置菜单没点开，继续尝试直接找关键词');
    }

    // 4) 幂等：先看是不是今天已经签过
    let text = await pageText(page);
    const doneHit = (pc.doneKeywords || []).find((k) => text.includes(k));
    if (doneHit) {
      // 只凭文案判断会误判：页面上常有属于别的活动的同款文案（例如豆包工作的「已领取」
      // 属于"选择工作领域领取奖励"，而每日签到其实还是「立即签到」）。
      // 真正可信的信号是——签到入口按钮已经不在了。
      const entryLeft = await findClickables(page, pc.keywords || ['签到']);
      if (entryLeft.length === 0) {
        return { status: 'already', detail: `页面显示「${doneHit}」且签到入口已消失，今天已完成` };
      }
      logger?.step(`页面出现了「${doneHit}」，但签到入口仍在，判定为今天还没签，继续`);
    }

    // 4.5) 演练模式：只报告"能不能点到"，不执行任何调用
    if (dryRun) {
      const cands = await findClickables(page, pc.keywords || ['签到', '领取']);
      let selHit = null;
      for (const sel of pc.clickSelectors || []) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 800 })) {
            selHit = sel;
            break;
          }
        } catch {
          /* next */
        }
      }
      const hit = cands.length ? cands.map((c) => c.text).slice(0, 4).join(' / ') : selHit;
      return hit
        ? { status: 'dry_run', detail: `演练：登录正常，命中入口「${hit}」（未点击）` }
        : { status: 'not_found', detail: '演练：登录正常，但页面里没找到签到入口' };
    }

    // 5) 策略一：JS 直接调用（最稳，优先）
    if (pc.jsEval) {
      logger?.step('执行 jsEval');
      const r = await page.evaluate(async (code) => {
        try {
          // eslint-disable-next-line no-eval
          const v = await (0, eval)(code);
          return { ok: true, value: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      }, pc.jsEval);

      if (!r.ok) return { status: 'failed', detail: `jsEval 执行出错: ${r.error}` };
      const v = r.value || {};
      if (v.status) return { status: v.status, detail: v.detail || '' };
      return { status: 'success', detail: `jsEval 已执行，返回: ${JSON.stringify(v).slice(0, 200)}` };
    }

    // 5.5) 策略一·五：等特定元素出现（客户端刚启动时界面是逐步渲染的）
    if (pc.waitForSelector) {
      logger?.step(`等待元素 ${pc.waitForSelector}`);
      await page.waitForSelector(pc.waitForSelector, { timeout: Number(pc.waitTimeoutMs || 30000) }).catch(() => {
        logger?.warn(`等待 ${pc.waitForSelector} 超时，继续尝试后续策略`);
      });
    }

    // 5.6) 策略一·八：按 CSS 选择器点击（签到入口是图标而没有文字的客户端用这个）
    if (Array.isArray(pc.clickSelectors) && pc.clickSelectors.length) {
      for (const sel of pc.clickSelectors) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1200 })) {
            logger?.step(`命中选择器 ${sel}，点击`);
            await loc.click({ timeout: 5000 });
            await sleep(1500);
            const t3 = await pageText(page, 4000);
            const o3 = classifyOutcome(t3);
            if (o3.already) return { status: 'already', detail: `点击 ${sel} 后提示已完成` };
            if (o3.success) return { status: 'success', detail: `点击 ${sel} 后出现成功提示` };
            if (o3.fail) return { status: 'failed', detail: `点击 ${sel} 后出现失败提示` };
            return { status: 'uncertain', detail: `已点击 ${sel}，但没读到明确结果（看截图）` };
          }
        } catch {
          /* 换下一个选择器 */
        }
      }
      logger?.step('选择器都没命中，回退到文案匹配');
    }

    // 6) 策略二：DOM 点击（和网页端同一套逻辑）
    const login = await detectLogin(page, text);
    if (login.needLogin) return { status: 'needs_login', detail: login.reason };

    let res = await clickByKeywords(page, pc.keywords || ['签到', '领取'], logger, { label: pc.name || 'client' });
    if (!res.clicked) {
      logger?.step('首次未找到入口，等待 3 秒后重试（异步内容可能晚到）');
      await sleep(3000);
      res = await clickByKeywords(page, pc.keywords || ['签到', '领取'], logger, { label: pc.name || 'client' });
    }
    const out = res.outcome || {};
    if (out.already) return { status: 'already', detail: `点击后提示已完成（${res.text}）` };
    if (out.success) return { status: 'success', detail: `点击「${res.text}」后出现成功提示` };
    if (out.fail) return { status: 'failed', detail: `点击「${res.text}」后出现失败提示` };
    if (res.clicked) {
      await sleep(1800);
      const t2 = await pageText(page, 5000);
      const o2 = classifyOutcome(t2);
      const doneHit2 = (pc.doneKeywords || []).find((k) => t2.includes(k));
      const stillThere = (await findClickables(page, pc.keywords || ['签到'])).length > 0;

      // 最可信的判定：点完之后入口按钮消失了，且页面出现"已领取/已签到"类文案
      if (!stillThere && doneHit2) {
        return { status: 'success', detail: `点击「${res.text}」后入口消失，页面显示「${doneHit2}」` };
      }
      if (o2.success || o2.already) return { status: 'success', detail: `点击后页面提示 ${o2.success ? '成功' : '已完成'}` };
      if (stillThere) return { status: 'uncertain', detail: `已点击「${res.text}」但入口仍在，可能点击落到了遮挡层（看截图）` };
      return { status: 'uncertain', detail: `已点击「${res.text}」，入口已消失但没读到明确文案（看截图）` };
    }
    return { status: 'not_found', detail: `页面里没找到关键词按钮：${(pc.keywords || []).join('/')}` };
  } catch (e) {
    return { status: 'error', detail: String(e.message || e).split('\n')[0] };
  } finally {
    if (page && shotDir) await screenshot(page, shotDir, shotName || 'client').catch(() => null);
    try {
      browser.close?.();
    } catch {
      /* ignore */
    }
    // 如果原本就在运行（我们只是重启它），签完保留运行，不打断使用
    if (launchedPid && quitAfter && !wasRunningAtStart) await quitApp(launchedPid, execPath, logger);
  }
}
