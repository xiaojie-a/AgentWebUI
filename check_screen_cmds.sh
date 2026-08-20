#!/usr/bin/env bash
# =============================================================
# Termux 屏幕控制命令健康检查
# 用法: bash check_screen_cmds.sh
# 作用: 检测 termux-wake-lock / termux-brightness 等命令是否
#       存在且真正有效，并判断 Termux:API App 是否已安装响应。
# 说明: 所有命令均用 timeout 包裹，绝不让脚本挂起。
# =============================================================

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
BIN="$PREFIX/bin"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK] %s${NC}\n" "$1"; }
bad()  { printf "${RED}[FAIL] %s${NC}\n" "$1"; }
warn() { printf "${YELLOW}[WARN] %s${NC}\n" "$1"; }

echo "===== 环境 ====="
echo "PREFIX = $PREFIX"
if command -v timeout >/dev/null 2>&1; then
  ok "timeout 命令可用"
else
  bad "timeout 缺失（需要 coreutils: pkg install coreutils）"
  exit 1
fi

echo
echo "===== 1. 命令存在性 ====="
for c in termux-wake-lock termux-wake-unlock termux-brightness termux-screen-on; do
  if [ -x "$BIN/$c" ]; then ok "存在: $c"; else bad "缺失: $c"; fi
done
warn "提示: termux-screen-on 不存在是正常的（不在 Termux/termux-api 包中，历史代码误用）"

echo
echo "===== 2. 唤醒锁实测（termux-tools 自带，无需 API App）====="
if [ -x "$BIN/termux-wake-lock" ]; then
  timeout 5 "$BIN/termux-wake-lock" >/dev/null 2>&1
  [ $? -eq 0 ] && ok "termux-wake-lock 生效" || bad "termux-wake-lock 执行失败"
else
  bad "termux-wake-lock 缺失"
fi
if [ -x "$BIN/termux-wake-unlock" ]; then
  timeout 5 "$BIN/termux-wake-unlock" >/dev/null 2>&1
  [ $? -eq 0 ] && ok "termux-wake-unlock 生效" || bad "termux-wake-unlock 执行失败"
else
  bad "termux-wake-unlock 缺失"
fi

echo
echo "===== 3. 亮度调节实测（termux-brightness 依赖 Termux:API App）====="
if [ -x "$BIN/termux-brightness" ]; then
  timeout 5 "$BIN/termux-brightness" 200 >/dev/null 2>&1
  rc=$?
  case $rc in
    0)   ok "termux-brightness 正常（API App 已响应，亮度已设 200）" ;;
    124) bad "termux-brightness 超时无响应 → Termux:API App 未安装或未授权" ;;
    *)   bad "termux-brightness 退出码 $rc" ;;
  esac
else
  bad "termux-brightness 缺失"
fi

echo
echo "===== 4. Termux:API App 探测（辅助信息）====="
if [ -x "$BIN/termux-apps-info-app-version-name" ]; then
  ver=$(timeout 5 "$BIN/termux-apps-info-app-version-name" com.termux.api 2>&1 | head -1)
  echo "termux-apps-info 查询: ${ver:-（无输出）}"
else
  warn "termux-apps-info-app-version-name 缺失（跳过 App 名查询）"
fi
if timeout 5 dumpsys package com.termux.api >/dev/null 2>&1; then
  ok "dumpsys 可查 com.termux.api（App 已安装）"
else
  warn "dumpsys 不可用或无权限（Termux 常规环境，忽略此项）"
fi

echo
echo "===== 结论 ====="
if [ -x "$BIN/termux-wake-lock" ]; then
  ok "唤醒锁可用 → 服务器防休眠功能正常"
else
  bad "唤醒锁不可用 → 后台任务可能被系统休眠打断"
fi
if [ -x "$BIN/termux-brightness" ]; then
  timeout 5 "$BIN/termux-brightness" 200 >/dev/null 2>&1
  if [ $? -eq 0 ]; then
    ok "亮度调节可用（Termux:API App 已安装并响应）"
  else
    warn "亮度调节不可用 → 如需使用：手机 F-Droid/Play 商店安装 Termux:API，装完重开 Termux；不影响唤醒锁与聊天功能"
  fi
fi
echo
echo "===== 完 ====="
