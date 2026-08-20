@echo off
rem 一键启动 agent-mini WebUI（桥接服务 + Web 服务）
cd /d %~dp0
start "agent-mini bridge" "C:\Users\Administrator\.workbuddy\binaries\python\envs\agent-mini\Scripts\python.exe" agent_bridge.py
timeout /t 2 /nobreak >nul
start "agent-mini webui" "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
echo WebUI: http://localhost:3000
