#!/usr/bin/env bash
#
# agent-mini WebUI 启动脚本（Termux / Linux）
#
# 用法：
#   ./start.sh          启动 bridge + webui（后台常驻）
#   ./start.sh stop     停止全部
#   ./start.sh restart  重启
#   ./start.sh status   查看运行状态
#
# 依赖：
#   - 一个已安装 agent_mini 的 Python（建议建 venv）。用环境变量 AGENT_MINI_PYTHON
#     指定解释器，默认 python3。
#   - Node.js（Termux: pkg install nodejs）。用环境变量 NODE_BIN 指定，默认 node。
#   - agent-mini 的配置文件需指向可达的 Ollama 服务（本机或远程地址）。
#
# 说明：
#   与 Windows 版 start.bat 不同，这里不再依赖任何 GPU 监控脚本，也不硬编码
#   Windows 绝对路径；所有路径/解释器都可通过环境变量覆盖，适配 Termux 环境。
#
set -u

# 切到脚本所在目录，保证相对路径正确
cd "$(dirname "$0")"

# ---------- 可配置项（环境变量覆盖）----------
# ---------- 自动检测 Python 环境 ----------
# 检查 pipx 安装的 agent-mini
if [ -z "${AGENT_MINI_PYTHON:-}" ]; then
    # 查找 pipx 虚拟环境
    PIPX_VENV="/home/xem/.local/share/pipx/venvs/agent-mini"
    if [ -f "$PIPX_VENV/bin/python" ] && "$PIPX_VENV/bin/python" -c "import agent_mini" 2>/dev/null; then
        PY="$PIPX_VENV/bin/python"
        echo "✅ 使用 pipx 虚拟环境: $PY"
        # 设置 PYTHONPATH 为 site-packages
        SITE_PKG=$($PY -c "import site; print(site.getsitepackages()[0])")
        export PYTHONPATH="$SITE_PKG"
    elif python3 -c "import agent_mini" 2>/dev/null; then
        PY="python3"
        echo "✅ 使用系统 Python"
    else
        # 尝试用户 site-packages
        USER_SITE=$(python3 -c "import site; print(site.getusersitepackages())" 2>/dev/null || echo "")
        if [ -n "$USER_SITE" ] && python3 -c "import sys; sys.path.insert(0, '$USER_SITE'); import agent_mini" 2>/dev/null; then
            export PYTHONPATH="$USER_SITE"
            PY="python3"
            echo "✅ 使用用户 site-packages: $USER_SITE"
        else
            PY="python3"
            echo "⚠️  警告: 未找到 agent_mini"
        fi
    fi
else
    PY="$AGENT_MINI_PYTHON"
fi

# 导出供子进程使用

NODE="${NODE_BIN:-node}"
BRIDGE_PORT="${BRIDGE_PORT:-8765}"
WEB_PORT="${PORT:-3000}"

# webui 后端连接桥接服务的地址
export PYTHONPATH
export AGENT_MINI_PYTHON="$PY"
export AGENT_BRIDGE="http://127.0.0.1:${BRIDGE_PORT}"
export BRIDGE_PORT
export PORT="$WEB_PORT"

LOG_DIR="./logs"
PID_DIR="./.pids"
BRIDGE_PID="$PID_DIR/bridge.pid"
WEB_PID="$PID_DIR/web.pid"
BRIDGE_LOG="$LOG_DIR/bridge.log"
WEB_LOG="$LOG_DIR/web.log"

is_running() {
  local pidfile="$1"
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null)"
  [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null
}

stop_one() {
  local name="$1" pidfile="$2"
  if is_running "$pidfile"; then
    local pid
    pid="$(cat "$pidfile")"
    echo "停止 $name (pid $pid) ..."
    kill "$pid" 2>/dev/null
    # 等一小会，未退出再强杀
    local i
    for i in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$pidfile"
}

stop_all() {
  stop_one "webui"  "$WEB_PID"
  stop_one "bridge" "$BRIDGE_PID"
  echo "已停止。"
}

status() {
  if is_running "$BRIDGE_PID"; then echo "bridge : 运行中 (pid $(cat "$BRIDGE_PID"))"; else echo "bridge : 未运行"; fi
  if is_running "$WEB_PID";     then echo "webui  : 运行中 (pid $(cat "$WEB_PID"))";     else echo "webui  : 未运行"; fi
}

bridge_ready() {
  "$PY" -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:${BRIDGE_PORT}/health', timeout=1); sys.exit(0)" 2>/dev/null
}

start_all() {
  mkdir -p "$LOG_DIR" "$PID_DIR"

  # 防止手机进入后台后被系统回收（仅 Termux 环境有效，无则忽略）
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null || true
  fi

  if is_running "$BRIDGE_PID"; then
    echo "bridge 已在运行 (pid $(cat "$BRIDGE_PID"))"
  else
    echo "启动 agent-mini 桥接服务 (端口 $BRIDGE_PORT) ..."
    # </dev/null 让后台进程不持有 SSH 管道，避免在远程会话中启动时挂起
    nohup "$NODE" agent_bridge.js >"$BRIDGE_LOG" 2>&1 </dev/null &
    echo $! >"$BRIDGE_PID"
  fi

  # 等待桥接服务就绪（最多 30s）
  echo -n "等待桥接服务就绪"
  local ready=0 i=0
  while [ "$i" -lt 30 ]; do
    if bridge_ready; then ready=1; break; fi
    sleep 1
    echo -n "."
    i=$((i+1))
  done
  echo ""
  if [ "$ready" -ne 1 ]; then
    echo "警告：桥接服务 30s 内未就绪，请查看 $BRIDGE_LOG"
  fi

  if is_running "$WEB_PID"; then
    echo "webui 已在运行 (pid $(cat "$WEB_PID"))"
  else
    echo "启动 WebUI 服务 (端口 $WEB_PORT) ..."
    # </dev/null 让后台进程不持有 SSH 管道，避免在远程会话中启动时挂起
    nohup "$NODE" server.js >"$WEB_LOG" 2>&1 </dev/null &
    echo $! >"$WEB_PID"
  fi

  sleep 1
  echo ""
  echo "========================================="
  echo " agent-mini WebUI 已启动 当前node版"
  echo " 浏览器打开 : http://localhost:${WEB_PORT}"
  echo " 桥接服务   : http://127.0.0.1:${BRIDGE_PORT}"
  echo " 日志目录   : $LOG_DIR"
  echo " 停止命令   : ./startnode.sh stop"
  echo "========================================="
}

case "${1:-start}" in
  start)   start_all ;;
  stop)    stop_all ;;
  restart) stop_all; sleep 1; start_all ;;
  status)  status ;;
  *) echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac
