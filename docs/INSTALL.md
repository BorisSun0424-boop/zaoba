# 早八 · 安装与权限说明

面向"想在自己 Mac 上跑起来"的用户。全程不需要终端经验的部分会标注 **[交给 AI Agent]**。

---

## 0. 这个工具是什么

> 只想尽快跑起来？看 **[上手教程](./GETTING-STARTED.md)**，本文档偏完整说明与排障。

一个**跑在你本机的定时程序**：每天到点帮你完成各 AI 工具的签到/领积分，跑完发通知，并提供一个本地网页控制台看状态。

它不是 SaaS。**所有数据、登录态、账号操作都在你本机**，控制台只监听 `127.0.0.1`，不对外网开放。

它**不依赖任何 AI Agent**——Agent 只是"帮你安装"的一个可选途径。

---

## 1. 前置条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | macOS 12+ 或 Windows 10/11 | macOS 的 Apple Silicon 最佳；Intel 可用但客户端类平台较慢 |
| 运行时 | **Node.js ≥ 18** | 核心依赖；用 `node -v` 检查 |
| 磁盘 | ≥ 1.5GB | 依赖约 100MB + Chromium 内核约 570MB（Windows 默认复用系统 Edge 可省掉） |
| 网络 | 可访问 nodejs.org / npm / 各平台站点 | 首次安装需要 |
| 系统状态 | **已登录桌面会话** | 定时任务属于用户会话，停在登录界面不会跑 |
| 权限 | 无需管理员密码（除安装 Node 的 pkg 方式） | 项目不放在受保护目录则不需要"完全磁盘访问权限" |

---

## 2. 安装（三种方式，任选一种）

> **Windows 用户**：把下面命令里的 `bash xxx.sh` 换成
> `powershell -ExecutionPolicy Bypass -File scripts\xxx.ps1`，
> 定时任务由「任务计划程序」承载（`install-service.ps1`）。

### 方式 A：交给 AI Agent **[推荐给非开发者]**

把 [`docs/AGENT-PROMPT.md`](./AGENT-PROMPT.md) 里那段指令整段复制给你常用的 AI Agent（Claude Code / Cursor / DeepSeek Harness / WorkBuddy 等），它会：

1. 检查系统与 Node 版本
2. 缺 Node 就按你的选择装（Homebrew / 官方 pkg / nvm）
3. 拉取代码、装依赖、下载浏览器内核
4. 引导你完成各平台登录（**扫码必须你本人操作**）
5. 安装定时任务（可选）并跑一次演练验证
6. 汇报结果与待办

Agent 会遵守几条硬约束：不删你任何文件、不碰系统目录、`sudo` 前必须先问你、不把登录态上传到任何地方。

### 方式 B：一键脚本（有终端经验）

```bash
# 1) 拿到代码
git clone https://github.com/BorisSun0424-boop/zaoba.git
cd zaoba

# 国内直连 github.com 不稳定时，用镜像（内容一致）：
# git clone https://ghfast.top/https://github.com/BorisSun0424-boop/zaoba.git zaoba

# 2) 先自检，看看缺什么
bash scripts/bootstrap.sh --check

# 3) 正式安装（会自动处理 Node 缺失、依赖、浏览器内核）
bash scripts/bootstrap.sh

# 4) 想顺便装"每日定时 + 常驻控制台"
bash scripts/bootstrap.sh --with-service
```

`bootstrap.sh` 是**幂等**的，重复执行不会出问题。参数：

| 参数 | 作用 |
| --- | --- |
| `--check` | 只检查，不做任何改动 |
| `--with-service` | 安装 launchd（每日 08:00 / 12:30 签到 + 常驻控制台 :7788） |
| `--skip-browser` | 跳过 570MB Chromium（只用客户端类平台时可加） |

### 方式 C：手动命令（完全掌控每一步）

```bash
# 1) Node ≥18（三选一）
brew install node                                  # 有 Homebrew
# 或
curl -fLO https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg && sudo installer -pkg node-v22.14.0.pkg -target /
# 或 nvm install --lts

# 2) 依赖与浏览器内核
cd zaoba
npm install
npx playwright install chromium

# 3) 生成配置
cp config.example.json config.json

# 4) 验证
node src/index.js list
node src/index.js run --dry-run      # 只检查不签到

# 5) 打开控制台
npm run web                          # → http://127.0.0.1:7788
```

---

## 3. 首次登录（必须你本人操作）

脚本**不能代替你登录**（扫码/验证码必须真人）。每个平台只需登一次，之后复用登录态。

| 平台 | 怎么登录 | 登录态存在哪 |
| --- | --- | --- |
| **WorkBuddy** | 打开 WorkBuddy 客户端，扫码登录 | 客户端自己的目录（脚本直接复用，不用额外登录） |
| **智谱清言** | 在本目录执行 `npm run login`，浏览器扫码 | 本项目的 `profile/` 目录 |
| **Trae CN / Qoder CN** | 分别在各自客户端里登录 | 各自客户端目录 |

> `profile/` 等价于你的账号凭据，**不要提交、不要分享**（`.gitignore` 已排除）。

登录完成后验证：

```bash
npm run checkin -- --only=workbuddy   # 单平台真跑
npm run dry-run                       # 全部平台只检查
```

---

## 4. 平台支持矩阵（重要：决定你要装什么）

| 平台 | 需要装客户端？ | 需要登录 | 每日收益 | 状态 |
| --- | --- | --- | --- | --- |
| **WorkBuddy** | ✅ 必须（腾讯客户端） | 客户端扫码 | 100 Credits | ✅ 可用 |
| **智谱清言** | ❌ 不需要（纯网页） | `npm run login` | 登录积分 | ✅ 可用 |
| **豆包工作** | ✅ 必须（字节客户端） | 客户端扫码 | 每日签到 +200 额度 | ✅ 可用 |
| **Trae CN** | ✅ 必须 | 客户端登录 | 150 积分（仅国内版） | ⚠️ 需装客户端后启用 |
| **Qoder CN** | ✅ 必须 | 客户端登录 | 100 Credits | ⚠️ 需装客户端后启用 |
| 通义万相 | ❌ 网页 | 网页登录 | — | ⚠️ 接口存活但产品疑下线 |
| 豆包（个人版） | 签到在**手机 App / 活动弹窗** | — | — | ❌ 未发现稳定入口 |
| 腾讯元宝 | 签到在**手机 App** | — | — | ❌ Mac 端做不了 |
| Kimi / 文心 / 千问 / 智谱开放平台 | — | — | 没有签到机制 | ❌ 不适用 |

**结论**：典型组合是「装这个工具 + 装 WorkBuddy 客户端」。网页类平台不需要你另装浏览器，Playwright 自带 Chromium。

---

## 4.5 修改运行时间

装好之后随时可以改，三种方式任选：

```bash
npm run schedule                       # 看当前设置
npm run schedule -- 07:45              # 改成 7:45（会立即重写 launchd 并生效）
npm run schedule -- 07:45 --delay=10   # 7:45 起，随机延迟 0~10 分钟
npm run schedule -- 08:00 --no-retry   # 关掉中午补跑
```

或者在网页控制台右上角点 `⏰ 8:00` 直接改，保存即生效。

> 手动改 `config.json` 之后，需要执行 `bash scripts/install-launchd.sh` 让 launchd 重新读取。

## 4.8 打开控制台 & 电源设置

```bash
bash scripts/install-shortcuts.sh    # 一键入口：App + 桌面书签 + 快捷键说明
npm run open                         # 或命令行直接打开（服务没起会自动拉起）
```

电源设置（让 08:00 的任务真的能跑）：

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00
```

锁屏**不影响**执行；系统**睡眠**才会错过（12:30 补跑兜底）。

## 5. 系统权限与电源设置

### 5.1 通知权限

签到结果通过 macOS 通知推送。首次收到时若没弹窗，去
**系统设置 → 通知** 里允许 `osascript` / 终端（视运行环境而定）发通知。

### 5.2 锁屏 vs 睡眠（最容易踩的坑）

| 系统状态 | 定时任务会跑吗 | 说明 |
| --- | --- | --- |
| 屏幕锁定 / 屏保 | ✅ 会 | 不影响定时任务；浏览器是无头模式，不需要窗口 |
| 屏幕关闭但系统未睡 | ✅ 会 | 同上 |
| **系统睡眠**（合盖 / 空闲睡眠） | ❌ **不会** | 到点不执行，唤醒后才补跑，可能已错过当天窗口 |
| 停在登录界面（未登录） | ❌ 不会 | 定时任务属于用户会话 |

所以关键不是"锁屏"，而是**别让电脑在签到时间处于睡眠**。两种做法：

```bash
# 做法 1：让系统每天 08:25 自动唤醒（推荐，需要一次管理员授权）
sudo pmset repeat wakeorpoweron MTWRFSU 08:25:00

# 查看当前电源设置
pmset -g
pmset -g sched      # 看已排的唤醒事件
```

做法 2：签到时间保持在电脑通常开机的时段；或者笔记本合盖时接电源并允许"网络唤醒"。

> 本工具已经做了兜底：**08:00 主跑 + 12:30 补跑**，并带"已签跳过"判断，所以即使早上睡过了，中午开机还能补上。

### 5.3 其他权限

- **无需"完全磁盘访问权限"**（只要项目不放在 `~/Desktop`、`~/Documents`、`~/Downloads` 这类受保护目录）
- **无需辅助功能权限**（不模拟鼠标键盘，走 CDP 调试端口）

---

## 6. 日常使用

```bash
cd zaoba

npm run web        # 可视化控制台 → http://127.0.0.1:7788（常驻服务时自动启动）
npm run list       # 平台状态
npm run checkin    # 手动跑一次（自动跳过今天已完成的）
npm run dry-run    # 演练：只检查不签到
npm run report     # 今天的日报
npm run clients    # 扫描本机可接管的客户端
```

数据位置：

```
data/results.jsonl        每次运行的结构化结果
data/reports/YYYY-MM-DD.md 日报
data/shots/<日期>/         截图（排障用）
data/log/                  日志
```

---

## 6.5 Windows 说明

| 项目 | macOS | Windows |
| --- | --- | --- |
| 一键安装 | `bash scripts/bootstrap.sh` | `powershell -File scripts\bootstrap.ps1` |
| 装定时任务 | `bash scripts/install-launchd.sh` | `powershell -File scripts\install-service.ps1` |
| 定时载体 | launchd（LaunchAgent） | 任务计划程序（schtasks，任务名 `ZaobaDailyCheckin`） |
| 卸载任务 | `bash scripts/uninstall-launchd.sh` | `powershell -File scripts\uninstall-service.ps1` |
| 通知 | 通知中心 | Windows 气泡通知 |
| 客户端接管 | 已实测 | 代码已实现，**尚未真机验证**；网页类平台可直接用 |

**Windows 默认用系统 Edge**（`channel: "msedge"`）：省掉 570MB 内核下载，登录窗口就是你熟悉的 Edge 外观；
登录态仍存在独立的 `profile\` 目录，不碰你日常 Edge 的账号与书签。想改回自带 Chromium：改 `config.json` 的 `channel` 或删掉该字段。

Windows 下客户端默认路径候选：

```
WorkBuddy   : %LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe
              C:\Program Files\WorkBuddy\WorkBuddy.exe
豆包工作     : %LOCALAPPDATA%\Programs\DoubaoWork\DoubaoWork.exe
              C:\Program Files\DoubaoWork\DoubaoWork.exe
```

路径不对时，改 `config.json` 里对应平台的 `app`（或在 `platforms.<id>.appCandidates` 里加你的路径）。
如果创建计划任务提示权限不足，用「以管理员身份运行」的 PowerShell 重试一次。

## 7. 升级 / 卸载

```bash
# 升级
cd zaoba && git pull && npm install

# 只停掉定时任务（保留数据与登录态）
bash scripts/uninstall-launchd.sh

# 彻底移除：删掉整个项目目录即可（profile/ 里是登录态，会一起删）
```

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `node: command not found` | Node 没装或没进 PATH。用 `bash scripts/bootstrap.sh --check` 定位 |
| `Executable doesn't exist ... chromium` | 没下载浏览器内核：`npx playwright install chromium` |
| 早上没签上，显示 `📴 offline` | 定时那会儿系统睡眠/网络未就绪。已加多源重试 + 12:30 补跑；也可配 `pmset` 定时唤醒 |
| `needs_login` | 登录态过期。WorkBuddy 打开客户端重登；智谱跑 `npm run login` |
| `needs_manual`（WorkBuddy） | 客户端开着但没调试端口。重跑 `bash scripts/install-launchd.sh` 恢复环境变量，或先完全退出客户端 |
| `not_found`（找不到签到按钮） | 平台改版。跑 `npm run probe -- --only=xxx` 看页面实际按钮文案，改 `config.json` 的 `keywords` |
| `not_installed` | 该平台需要客户端但没装，或 `config.json` 里 `app` 路径不对 |
| 控制台打不开 | 服务没起：`npm run web`；或常驻服务没装：`bash scripts/install-launchd.sh` |
| 通知不弹 | 系统设置 → 通知 → 允许对应程序 |

---

## 9. 安全与隐私

- 登录态只存在本机（`profile/` 或各客户端自己的目录），代码里没有任何上报
- 控制台只监听 `127.0.0.1`，接口只有读状态 / 触发签到 / 切换启用，没有任意命令执行
- 仓库里不含任何凭据；`config.json`、`profile/`、`data/` 都在 `.gitignore` 中
- 建议只用在自己常用设备、每天低频运行（本来就是每天一次）

---

## 10. 已知限制

1. macOS 已完整验证；Windows 的一键脚本/网页类平台已适配，客户端类平台（WorkBuddy/豆包工作/Trae）代码已实现但**尚未真机验证**，Linux 未适配
2. 网页类平台依赖 Playwright 的无头浏览器（首次装 570MB，Windows 复用 Edge 可省）
3. 客户端类平台依赖客户端版本；客户端大版本更新后可能需要更新适配器
4. 手机 App 内的签到（豆包个人版、腾讯元宝）无法覆盖
5. 平台用户协议多数禁止自动化，账号风险自负，请低频自用
