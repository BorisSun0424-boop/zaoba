import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

export function summary() {
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    supported: isWindows || isMacOS,
    scheduler: isWindows ? 'schtasks' : isMacOS ? 'launchd' : 'none',
  };
}

/* ------------------------------------------------------------------ *
 * 已知客户端的默认安装路径（按系统）
 * ------------------------------------------------------------------ */

const WIN_LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const WIN_PF = process.env.ProgramFiles || 'C:\\Program Files';
const WIN_PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

export const knownAppPaths = {
  workbuddy: isMacOS
    ? ['/Applications/WorkBuddy.app']
    : [
        path.join(WIN_LOCAL, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_PF, 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_PF86, 'WorkBuddy', 'WorkBuddy.exe'),
        path.join(WIN_LOCAL, 'WorkBuddy', 'WorkBuddy.exe'),
      ],
  doubaowork: isMacOS
    ? ['/Applications/DoubaoWork.app']
    : [
        path.join(WIN_LOCAL, 'Programs', 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_PF86, 'DoubaoWork', 'DoubaoWork.exe'),
        path.join(WIN_LOCAL, 'DoubaoWork', 'DoubaoWork.exe'),
      ],
  doubao: isMacOS
    ? ['/Applications/Doubao.app']
    : [path.join(WIN_LOCAL, 'Programs', 'Doubao', 'Doubao.exe'), path.join(WIN_PF, 'Doubao', 'Doubao.exe')],
  trae: isMacOS ? ['/Applications/Trae CN.app'] : [path.join(WIN_LOCAL, 'Programs', 'Trae CN', 'Trae CN.exe')],
  qoder: isMacOS ? ['/Applications/Qoder.app'] : [path.join(WIN_LOCAL, 'Programs', 'Qoder', 'Qoder.exe')],
};

/** 登录态的全局存放位置：放在用户主目录，重新下载/换目录都不会丢 */
export function defaultProfileDir() {
  return process.env.ZAOBA_PROFILE || path.join(os.homedir(), '.zaoba', 'profile');
}

/** 各客户端平台的官方下载页（用于「去下载」按钮） */
export const downloadUrls = {
  workbuddy: 'https://copilot.tencent.com/',
  doubaowork: 'https://www.doubao.com/download/',
  'doubaowork-client': 'https://www.doubao.com/download/',
  trae: 'https://www.trae.cn/',
  'trae-cn': 'https://www.trae.cn/',
  qoder: 'https://qoder.com/',
  'qoder-cn': 'https://qoder.com/',
  doubao: 'https://www.doubao.com/download/',
  'doubao-client': 'https://www.doubao.com/download/',
};

/* ------------------------------------------------------------------ *
 * 可执行文件解析
 * ------------------------------------------------------------------ */

/** macOS: 传 .app 目录时解析出里面的可执行文件；Windows/Linux: 直接用路径 */
export function resolveExecutable(appOrBin) {
  if (!appOrBin) throw new Error('缺少 app/bin 配置');
  if (isMacOS && appOrBin.endsWith('.app')) {
    const macosDir = path.join(appOrBin, 'Contents', 'MacOS');
    const exe = fs.readdirSync(macosDir).find((f) => !f.startsWith('.'));
    if (!exe) throw new Error(`${appOrBin} 里找不到可执行文件`);
    return path.join(macosDir, exe);
  }
  return appOrBin;
}

/** 从候选路径里挑第一个存在的（用于跨平台默认路径） */
export function pickAppPath(candidates = []) {
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(c)) return c;
  }
  return candidates[0] || null;
}

/* ------------------------------------------------------------------ *
 * 进程检测与退出
 * ------------------------------------------------------------------ */

export async function isProcessRunning(execPath) {
  if (!execPath) return false;
  if (isWindows) {
    const name = path.basename(execPath).replace(/\.exe$/i, '');
    try {
      const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH', '/FO', 'CSV'], { timeout: 8000 });
      return stdout.toLowerCase().includes(`${name.toLowerCase()}.exe`);
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await exec('pgrep', ['-f', execPath], { timeout: 8000 });
    if (stdout.trim()) return true;
    // 有些客户端（豆包/豆包工作这类原生 launcher）启动后主进程会自己退出，
    // 只留 helper / 内核进程在后台继续跑。只按主进程路径查会漏判成「没在运行」，
    // 后果是退出清理不生效 → 单实例锁残留 → 下次启动拿不到调试端口。
    // 所以再按整个 bundle 目录兜底查一次。
    const bundle = String(execPath).match(/^(.+\.app)\/Contents\//)?.[1];
    if (!bundle) return false;
    const r2 = await exec('pgrep', ['-f', `${bundle}/Contents`], { timeout: 8000 });
    return r2.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 优雅退出：一级一级升级，最后兜底强杀。
 * macOS: osascript quit → SIGTERM → SIGKILL
 * Windows: taskkill（不带 /F，等同关闭窗口）→ taskkill /F
 */
export async function gracefulQuit({ appName, execPath, logger, waitMs = 20000 } = {}) {
  const running = () => isProcessRunning(execPath);
  if (!(await running())) return true;

  const name = isWindows ? path.basename(execPath || '').replace(/\.exe$/i, '') : '';

  // 第一级：礼貌请求退出
  if (isMacOS) {
    const target = appName || (execPath || '').match(/([^/]+)\.app\//)?.[1] || '';
    if (target) await exec('osascript', ['-e', `quit app "${target}"`]).catch(() => null);
  } else if (isWindows && name) {
    await exec('taskkill', ['/IM', `${name}.exe`, '/T'], { timeout: 10000 }).catch(() => null);
  }
  for (let i = 0; i < 16; i++) {
    if (!(await running())) return true;
    await sleep(500);
  }

  // 第二级：SIGTERM（mac）/ 强制结束（win）
  logger?.warn('优雅退出未完成，升级为强制结束');
  if (isMacOS) await exec('pkill', ['-f', execPath]).catch(() => null);
  else if (isWindows && name) await exec('taskkill', ['/F', '/IM', `${name}.exe`, '/T'], { timeout: 10000 }).catch(() => null);
  for (let i = 0; i < 12; i++) {
    if (!(await running())) return true;
    await sleep(500);
  }

  // 第三级：按 bundle 目录整体清理（mac）/ 再强制一次（win）
  if (isMacOS) {
    const bundleDir = execPath.includes('.app/Contents/') ? execPath.slice(0, execPath.indexOf('.app/Contents/') + 4) : '';
    if (bundleDir) await exec('pkill', ['-9', '-f', `${bundleDir}/Contents`]).catch(() => null);
    else await exec('pkill', ['-9', '-f', execPath]).catch(() => null);
    for (let i = 0; i < 10; i++) {
      if (!(await running())) return true;
      await sleep(500);
    }
  }
  logger?.warn('进程仍在运行，后续可能因单实例锁失败');
  return !(await running());
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */

function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

export async function notify(title, message, { sound = true } = {}) {
  if (isMacOS) {
    const esc = (s) => String(s).replace(/["\\\n\r]/g, (c) => ({ '"': '\\"', '\\': '\\\\', '\n': ' ', '\r': ' ' })[c]);
    const script = `display notification "${esc(message)}" with title "${esc(title)}"${sound ? ' sound name "Glass"' : ''}`;
    try {
      await exec('osascript', ['-e', script], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  if (isWindows) {
    // 用 WinForms 气泡通知，不依赖第三方模块
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.BalloonTipTitle = \'' + psQuote(title) + '\'',
      '$n.BalloonTipText = \'' + psQuote(message) + '\'',
      '$n.Visible = $true',
      '$n.ShowBalloonTip(8000)',
      'Start-Sleep -Seconds 7',
      '$n.Dispose()',
    ].join('; ');
    try {
      await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * 定时任务：macOS = launchd，Windows = 计划任务（schtasks）
 * ------------------------------------------------------------------ */

function macPlistXml({ label, projectDir, scriptPath, times }) {
  const blocks = times
    .map((t) => {
      const [h, m] = t.split(':').map(Number);
      return `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectDir}</string>
  <key>StartCalendarInterval</key>
  <array>
${blocks}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${projectDir}/data/log/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${projectDir}/data/log/launchd.err.log</string>
</dict>
</plist>
`;
}

/** Windows 计划任务 XML：错过（睡眠）后补跑 + 唤醒计算机执行 */
export function buildWindowsTaskXml({ time, nodeBin, scriptPath }) {
  const [h, m] = String(time).split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const start = `2026-01-01T${pad(h)}:${pad(m)}:00`;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>早八 zaoba 每日自动签到</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(nodeBin)}</Command>
      <Arguments>"${esc(scriptPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function schedulerLabel(base = 'com.local.ai-daily-checkin') {
  return base;
}

export function schedulerPath(base = 'com.local.ai-daily-checkin') {
  if (isWindows) return null;
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${base}.plist`);
}

/** 安装定时任务：times 为 ['08:00','12:30'] */
export async function installScheduler({ label = 'com.local.ai-daily-checkin', projectDir, scriptPath, times, logger }) {
  const valid = times.filter(Boolean);
  if (!valid.length) throw new Error('没有有效的时间点');

  if (isMacOS) {
    const plist = schedulerPath(label);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, macPlistXml({ label, projectDir, scriptPath, times: valid }), 'utf8');
    const uid = process.getuid();
    await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
    await sleep(800);
    try {
      await exec('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    } catch {
      await sleep(1500);
      await exec('launchctl', ['bootstrap', `gui/${uid}`, plist]).catch(async () => {
        await exec('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]).catch(() => null);
      });
    }
    return { method: 'launchd', plist, times: valid };
  }

  if (isWindows) {
    const created = [];
    // 非默认 label 时用独立任务名，避免覆盖真实任务
    const base = label === 'com.local.ai-daily-checkin' ? 'ZaobaDailyCheckin' : `ZaobaDailyCheckin-${label.replace(/[^a-z0-9]+/gi, '')}`;
    for (const [i, t] of valid.entries()) {
      const taskName = i === 0 ? base : `${base}${i + 1}`;
      const xmlPath = path.join(os.tmpdir(), `zaoba-task-${label.replace(/[^a-z0-9]+/gi, '')}-${i}.xml`);
      const xmlText = buildWindowsTaskXml({ time: t, nodeBin: process.execPath, scriptPath });
      fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlText, 'utf16le')]));
      await exec('schtasks', ['/Delete', '/TN', taskName, '/F'], { timeout: 15000 }).catch(() => null);
      try {
        // 用 XML 注册，才能带上 WakeToRun / StartWhenAvailable
        await exec('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], { timeout: 25000 });
      } catch (e) {
        // 回退：至少保证任务能跑
        logger?.warn(`XML 注册失败，回退到简单模式: ${String(e.message).split('\n')[0]}`);
        await exec(
          'schtasks',
          ['/Create', '/F', '/SC', 'DAILY', '/ST', t, '/TN', taskName, '/TR', `"${process.execPath}" "${scriptPath}"`],
          { timeout: 20000 },
        );
      }
      fs.rmSync(xmlPath, { force: true });
      created.push(taskName);
    }
    logger?.info(`已创建 Windows 计划任务: ${created.join(', ')}（含"错过则唤醒补跑"）`);
    return { method: 'schtasks', tasks: created, times: valid };
  }

  throw new Error(`当前系统（${process.platform}）暂不支持安装定时任务`);
}

export async function removeScheduler({ label = 'com.local.ai-daily-checkin', logger } = {}) {
  if (isMacOS) {
    const plist = schedulerPath(label);
    const uid = process.getuid();
    await exec('launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => null);
    if (fs.existsSync(plist)) fs.rmSync(plist, { force: true });
    return true;
  }
  if (isWindows) {
    const base = label === 'com.local.ai-daily-checkin' ? 'ZaobaDailyCheckin' : `ZaobaDailyCheckin-${label.replace(/[^a-z0-9]+/gi, '')}`;
    for (const name of [base, `${base}2`, `${base}3`]) {
      await exec('schtasks', ['/Delete', '/TN', name, '/F'], { timeout: 15000 }).catch(() => null);
    }
    logger?.info('已删除 Windows 计划任务');
    return true;
  }
  return false;
}

/** 读取实际生效的时间（用于校验），返回 ['08:00','12:30'] */
export async function schedulerEffective({ label = 'com.local.ai-daily-checkin' } = {}) {
  if (isMacOS) {
    const plist = schedulerPath(label);
    if (!fs.existsSync(plist)) return [];
    try {
      const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', plist]);
      const data = JSON.parse(stdout);
      const list = Array.isArray(data.StartCalendarInterval) ? data.StartCalendarInterval : [data.StartCalendarInterval];
      return list
        .filter(Boolean)
        .map((x) => `${String(x.Hour).padStart(2, '0')}:${String(x.Minute).padStart(2, '0')}`);
    } catch {
      return [];
    }
  }

  if (isWindows) {
    const out = [];
    for (const name of ['ZaobaDailyCheckin', 'ZaobaDailyCheckin2', 'ZaobaDailyCheckin3']) {
      try {
        const { stdout } = await exec('schtasks', ['/Query', '/TN', name, '/XML'], { timeout: 15000 });
        const m = stdout.match(/<StartBoundary>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        if (m) out.push(m[1].slice(11, 16));
      } catch {
        /* 该任务不存在 */
      }
    }
    return out;
  }
  return [];
}

/** 删除所有平台数据/配置前需要用户确认的提示语 */
export function platformNotes() {
  if (isWindows) {
    return [
      'Windows 下客户端需手动安装并登录；早八通过调试端口接管。',
      '首次创建计划任务时如果提示权限不足，请用「以管理员身份运行」的 PowerShell 重试一次。',
    ];
  }
  return [];
}

export default {
  isWindows,
  isMacOS,
  isLinux,
  summary,
  resolveExecutable,
  pickAppPath,
  isProcessRunning,
  gracefulQuit,
  notify,
  installScheduler,
  removeScheduler,
  schedulerEffective,
  schedulerLabel,
  schedulerPath,
  platformNotes,
  knownAppPaths,
  downloadUrls,
  defaultProfileDir,
  buildWindowsTaskXml,
};
