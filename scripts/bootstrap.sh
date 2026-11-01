#!/usr/bin/env bash
# AI 签到工具 · 一键安装 / 自检脚本
#
# 用法:
#   bash scripts/bootstrap.sh              # 完整安装（缺什么装什么）
#   bash scripts/bootstrap.sh --check      # 只自检，不做任何改动
#   bash scripts/bootstrap.sh --with-service   # 额外安装 launchd 定时任务 + 常驻控制台
#   bash scripts/bootstrap.sh --skip-browser   # 跳过 570MB 的 Chromium 下载
#
# 安全约定:
#   · 不对任何系统目录执行 rm -rf
#   · 需要 sudo 的步骤会先打印命令，由用户自己决定
#   · 全程可重复执行（幂等）
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

CHECK_ONLY=0
WITH_SERVICE=0
SKIP_BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --with-service) WITH_SERVICE=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: ${arg}（试试 --help）"; exit 2 ;;
  esac
done

FAILED=0
ok()   { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ! %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*"; FAILED=$((FAILED + 1)); }
step() { printf "\n[%s/7] %s\n" "$1" "$2"; }

echo "早八 zaoba · 安装检查"
echo "项目目录: $PROJECT_DIR"
echo "模式: $([ "$CHECK_ONLY" = 1 ] && echo '仅检查' || echo '完整安装')"

# ---------------------------------------------------------------- 1. 系统
step 1 "系统环境"
OS_NAME="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS_NAME" != "Darwin" ]; then
  # 这个脚本是 macOS 专用。Windows 用户有对应的 PowerShell 版，别让他们卡在一个冰冷的退出码上。
  IS_WINDOWS=0
  case "$OS_NAME" in
    MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  esac
  if [ "${OS:-}" = "Windows_NT" ]; then IS_WINDOWS=1; fi
  if [ "$IS_WINDOWS" = "1" ]; then
    echo ""
    echo "  ⚠️  检测到 Windows。这个 .sh 脚本是 macOS 专用的，无法在 Windows 上运行。"
    echo "  请改用 PowerShell 版本（在 PowerShell 里执行）："
    echo ""
    echo "      powershell -ExecutionPolicy Bypass -File scripts\\bootstrap.ps1 -Check   # 自检"
    echo "      powershell -ExecutionPolicy Bypass -File scripts\\bootstrap.ps1          # 安装"
    echo ""
  else
    echo ""
    echo "  ✗ 当前只支持 macOS 或 Windows（检测到 ${OS_NAME}）。"
  fi
  exit 1
fi
ok "macOS / $ARCH"
if [ "$ARCH" != "arm64" ]; then
  warn "非 Apple Silicon（x86_64）。功能可用，但客户端类平台可能更慢"
fi

# ---------------------------------------------------------------- 2. Node
step 2 "Node.js ≥ 18"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_RAW="$(node -v | sed 's/^v//')"
  NODE_MAJOR="${NODE_RAW%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null; then
    ok "node v${NODE_RAW}（$(command -v node)）"
    NODE_OK=1
  else
    warn "当前 node v$NODE_RAW 版本过低（需要 ≥18）"
  fi
else
  warn "没有找到 node"
fi

if [ "$NODE_OK" = 0 ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    fail "需要安装 Node ≥18（见下方命令）"
  elif command -v brew >/dev/null 2>&1; then
    echo "  → 用 Homebrew 安装（可能需要几分钟）"
    if brew install node; then
      hash -r
      ok "node 安装完成：$(node -v)"
      NODE_OK=1
    else
      fail "Homebrew 安装失败，请手动安装（见下）"
    fi
  else
    fail "没有 Homebrew，无法自动安装 Node"
  fi

  if [ "$NODE_OK" = 0 ]; then
    cat <<'NODEHELP'

  请任选一种方式安装 Node ≥18：

  A) 有 Homebrew：
       brew install node

  B) 没有 Homebrew（官方 pkg，需要管理员密码）：
       # 1) 看最新 LTS 版本号
       curl -s https://nodejs.org/dist/index.json | head -c 400
       # 2) 下载并安装（把 VERSION 换成实际版本，如 v22.14.0）
       curl -fLO https://nodejs.org/dist/VERSION/node-VERSION.pkg
       sudo installer -pkg node-VERSION.pkg -target /

  C) 用 nvm（不需要 sudo）：
       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
       source ~/.zshrc && nvm install --lts

NODEHELP
    exit 3
  fi
fi

# ---------------------------------------------------------------- 3. 依赖
step 3 "项目依赖（playwright）"
if [ -d node_modules/playwright ]; then
  ok "依赖已安装"
else
  if [ "$CHECK_ONLY" = 1 ]; then
    fail "缺少 node_modules，需要执行 npm install"
  else
    npm install --no-audit --no-fund
    ok "依赖安装完成"
  fi
fi

# ---------------------------------------------------------------- 4. 浏览器内核
step 4 "浏览器内核（首次约 570MB，可复用系统浏览器省掉）"
BROWSER_CACHE="${HOME}/Library/Caches/ms-playwright"

# 只有 Windows 才复用系统 Edge（省 570MB）；macOS 统一用 Playwright 自带 Chromium
# 原因：macOS 上用 channel=chrome 启动自定义 profile 会卡在握手阶段，窗口不出现
SYSTEM_CHANNEL=""
if [ "${FORCE_BROWSER:-0}" != "1" ] && [ "$(uname -s)" = "Darwin" ]; then
  SYSTEM_CHANNEL=""
fi

if [ -n "${SYSTEM_CHANNEL}" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    ok "检测到系统浏览器，可复用它（channel: ${SYSTEM_CHANNEL}），无需下载 570MB"
  else
    ( cd "$PROJECT_DIR" && [ -f config.json ] || node src/index.js list >/dev/null 2>&1 )
    node -e '
      const fs = require("fs");
      const f = "config.json";
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      c.channel = process.argv[1];
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
    ' "${SYSTEM_CHANNEL}"
    ok "已设为复用系统浏览器（channel: ${SYSTEM_CHANNEL}），跳过 570MB 下载"
    warn "注意：切换浏览器内核会让已有登录态失效（首次安装没有这问题）"
  fi
elif [ -d "$BROWSER_CACHE" ] && [ -n "$(ls -A "$BROWSER_CACHE" 2>/dev/null)" ]; then
  ok "浏览器内核已存在（$(du -sh "$BROWSER_CACHE" 2>/dev/null | cut -f1)）"
elif [ "$SKIP_BROWSER" = 1 ]; then
  warn "已跳过下载（网页类平台将不可用；客户端类平台不受影响）"
elif [ "$CHECK_ONLY" = 1 ]; then
  fail "缺少浏览器内核，需要执行 npx playwright install chromium"
else
  echo "  → 下载中，约 570MB，取决于网速"
  npx playwright install chromium
  ok "浏览器内核安装完成"
fi

# ---------------------------------------------------------------- 5. 配置文件
step 5 "配置文件"
if [ -f config.json ]; then
  ok "config.json 已存在"
elif [ -f config.example.json ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "缺少 config.json（运行时会自动从模板生成）"
  else
    cp config.example.json config.json
    ok "已从 config.example.json 生成 config.json"
  fi
else
  warn "没有模板配置，首次运行会自动生成默认配置"
fi

# ---------------------------------------------------------------- 6. 可选：系统服务
step 6 "定时任务与常驻控制台"
if [ "$WITH_SERVICE" = 1 ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    ok "（仅检查模式）会安装 launchd：每日签到 + 常驻控制台"
  else
    bash "$PROJECT_DIR/scripts/install-launchd.sh"
    ok "已安装 launchd（每日 08:00 / 12:30 签到 + 常驻控制台 :7788）"
  fi
else
  warn "未安装系统服务（需要时加 --with-service，或单独运行 scripts/install-launchd.sh）"
fi

# ---------------------------------------------------------------- 7. 自检
step 7 "功能自检"
if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$FAILED" -gt 0 ]; then
    echo "  · 检查完成：有 $FAILED 项待处理（退出码 1）。运行 bash scripts/bootstrap.sh 可自动补齐。"
    exit 1
  fi
  echo "  · 检查完成：环境已就绪，可以直接运行 npm run web 或 bash scripts/bootstrap.sh --with-service。"
  exit 0
fi

echo "  → 列平台"
node src/index.js list 2>&1 | sed -n '1,20p' | sed 's/^/    /'

echo ""
echo "  → 演练（只检查不签到）"
node src/index.js run --dry-run 2>&1 | tail -6 | sed 's/^/    /' || true

cat <<'DONE'

──────────────────────────────────────────────
安装完成。接下来两件事：

1) 登录（只需一次，必须你本人扫码）
   · WorkBuddy：打开客户端扫码登录即可（脚本复用它的登录态）
   · 智谱清言：在本目录执行  npm run login

2) 打开控制台
   npm run web        →  http://127.0.0.1:7788

常见问题、睡眠/锁屏设置、权限说明见 docs/INSTALL.md
──────────────────────────────────────────────
DONE
