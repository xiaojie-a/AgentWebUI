#!/usr/bin/env bash
# =============================================================
# agentwebui 守护进程（watchdog）
# 功能: 定时检查 bridge / webui / ollama，挂掉自动拉起，
#       防止 Android 系统回收后台进程导致服务中断。
#       每 GIT_SYNC_INTERVAL 次循环（默认 60 次 ≈ 10 分钟）
#       自动 git pull Gitee 仓库，代码更新则重启服务生效。
# 启动: bash watchdog.sh start
# 停止: bash watchdog.sh stop
# 状态: bash watchdog.sh status
# 日志: 全部写入 logs/watchdog.log（含每次 git 拉取结果），实时查看 tail -f logs/watchdog.log
#       前台直接运行 bash watchdog.sh loop 时日志同时实时打印到终端
# =============================================================
set -u
cd "$(dirname "$0")"

LOG="logs/watchdog.log"
PID_FILE=".pids/watchdog.pid"
NODE="${NODE_BIN:-node}"
BRIDGE_PORT="${BRIDGE_PORT:-8765}"
WEB_PORT="${PORT:-3000}"

# 自动拉取配置：循环次数间隔（10s × 60 = 10 分钟一次）
GIT_SYNC_INTERVAL="${GIT_SYNC_INTERVAL:-60}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"

ts() { date '+%F %T'; }
# 日志：始终落盘 logs/watchdog.log；前台直接跑 loop 时（stdout 是终端）同时实时打印
log() {
  local line="[$(ts)] $*"
  [ -t 1 ] && echo "$line"
  echo "$line" >> "$LOG"
}

start_watchdog() {
  mkdir -p logs .pids
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "watchdog 已在运行 (pid $(cat "$PID_FILE"))"
    return
  fi
  # stdout/stderr 并入日志文件（不再丢弃），后台运行时全部输出仍可 tail 查看
  nohup bash "$0" loop >>"$LOG" 2>&1 </dev/null &
  echo $! > "$PID_FILE"
  echo "watchdog 已启动 (pid $(cat "$PID_FILE"))"
  echo "实时查看: tail -f $LOG"
}

stop_watchdog() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
    echo "watchdog 已停止"
  else
    rm -f "$PID_FILE"
    echo "watchdog 未在运行"
  fi
}

status_watchdog() {
  local wd="未运行"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    wd="运行中 (pid $(cat "$PID_FILE"))"
  fi
  echo "watchdog: $wd"
  curl -s -m 2 "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1 \
    && echo "bridge:  OK" || echo "bridge:  DOWN"
  curl -s -m 2 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null 2>&1 \
    && echo "webui:   OK" || echo "webui:   DOWN"
  if [ -f ".pids/monitor.pid" ] && kill -0 "$(cat .pids/monitor.pid)" 2>/dev/null; then
    echo "monitor: OK"
  else
    echo "monitor: DOWN"
  fi
}

# 单服务守护：端口不通则杀掉旧进程并拉起
ensure() {
  local name="$1" port="$2" cmd="$3" pidfile="$4" logfile="$5"
  if curl -s -m 2 "http://127.0.0.1:$port" >/dev/null 2>&1; then
    return
  fi
  local oldpid=""
  [ -f "$pidfile" ] && oldpid="$(cat "$pidfile")"
  [ -n "$oldpid" ] && kill "$oldpid" 2>/dev/null
  log "[$name] 失联，正在重启..."
  nohup $cmd >>"$logfile" 2>&1 </dev/null &
  echo $! > "$pidfile"
  log "[$name] 已重启 (pid $(cat "$pidfile"))"
}

# 进程守护：非端口类服务（如 monitor_tool），pidfile + kill -0 探活
ensure_proc() {
  local name="$1" cmd="$2" pidfile="$3" logfile="$4"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return
  fi
  local oldpid=""
  [ -f "$pidfile" ] && oldpid="$(cat "$pidfile")"
  [ -n "$oldpid" ] && kill "$oldpid" 2>/dev/null
  log "[$name] 失联，正在重启..."
  nohup $cmd >>"$logfile" 2>&1 </dev/null &
  echo $! > "$pidfile"
  log "[$name] 已重启 (pid $(cat "$pidfile"))"
}

# 自动拉取 Gitee 更新：ff-only 安全快进，代码变化则重启 bridge/webui。
# 每次检查都留痕（fetch 失败 / 合并冲突 / 已更新 / 无更新），便于后台排查。
git_sync() {
  command -v git >/dev/null 2>&1 || { log "git_sync: git 未安装，跳过"; return; }
  [ -d .git ] || { log "git_sync: 非 git 仓库，跳过"; return; }
  local before after ferr merr
  before="$(git rev-parse --short HEAD 2>/dev/null)"
  ferr="$(git fetch "$GIT_REMOTE" "$GIT_BRANCH" 2>&1)" || {
    log "git_sync: fetch 失败（网络/凭据?）: $(echo "$ferr" | tail -1 | cut -c1-140)，保留 $before"
    return
  }
  merr="$(git merge --ff-only "$GIT_REMOTE/$GIT_BRANCH" 2>&1)" || {
    log "git_sync: 拉取失败（可能有本地改动冲突）: $(echo "$merr" | tail -1 | cut -c1-140)，保留 $before"
    return
  }
  after="$(git rev-parse --short HEAD 2>/dev/null)"
  if [ "$before" != "$after" ]; then
    log "git_sync: 代码已更新 $before -> $after，重启服务生效"
    # 杀掉 bridge/webui 旧进程，下一轮 ensure 会自动拉起新代码
    [ -f ".pids/bridge.pid" ] && kill "$(cat .pids/bridge.pid)" 2>/dev/null
    [ -f ".pids/web.pid" ] && kill "$(cat .pids/web.pid)" 2>/dev/null
  else
    log "git_sync: 检查完成，无新更新（HEAD=$before）"
  fi
}

loop() {
  local i=0
  log "watchdog 守护已启动 (PID $$)"
  while true; do
    ensure "bridge" "$BRIDGE_PORT" "$NODE agent_bridge.js" ".pids/bridge.pid" "logs/bridge.log"
    ensure "webui"  "$WEB_PORT"    "$NODE server.js"       ".pids/web.pid"    "logs/web.log"
    # 本机监控（电量/CPU）：写 monitor.json 供 /api/monitor 读取
    ensure_proc "monitor" "python3 monitor_tool.py" ".pids/monitor.pid" "logs/monitor.log"
    if command -v ollama >/dev/null 2>&1; then
      ensure "ollama" "11434" "ollama serve" ".pids/ollama.pid" "logs/ollama.log"
    fi
    # 每 N 次循环自动拉取一次（默认 60 次 ≈ 10 分钟）
    i=$((i + 1))
    if [ $i -ge "$GIT_SYNC_INTERVAL" ]; then
      i=0
      git_sync
    fi
    sleep 10
  done
}

case "${1:-}" in
  start)  start_watchdog ;;
  stop)   stop_watchdog ;;
  status) status_watchdog ;;
  loop)   loop ;;
  *) echo "用法: bash watchdog.sh [start|stop|status]"; exit 1 ;;
esac
