#!/usr/bin/env bash
# 一键恢复 Termux 全部服务（重启手机后执行: bash ~/webui/restart_all.sh）
cd ~/webui
mkdir -p logs .pids
export AGENT_BRIDGE="http://127.0.0.1:8765"

# 1. sshd
pkill -f sshd 2>/dev/null; sleep 1
sshd
echo "[restart] sshd OK (端口 8022)"

# 2. ollama
if ! curl -s -m 2 http://127.0.0.1:11434 >/dev/null 2>&1; then
  nohup ollama serve >logs/ollama.log 2>&1 </dev/null &
  echo $! > .pids/ollama.pid
  echo "[restart] ollama 启动中..."
fi

# 3. bridge + webui
if ! curl -s -m 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  nohup node agent_bridge.js >>logs/bridge.log 2>&1 </dev/null &
  echo $! > .pids/bridge.pid
  echo "[restart] bridge 启动中..."
fi
if ! curl -s -m 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  nohup node server.js >>logs/web.log 2>&1 </dev/null &
  echo $! > .pids/web.pid
  echo "[restart] webui 启动中..."
fi

# 4. 屏幕控制唤醒锁
termux-wake-lock 2>/dev/null

# 5. watchdog
bash watchdog.sh stop 2>/dev/null
bash watchdog.sh start
echo "[restart] 全部完成"
