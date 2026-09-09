@echo off
cd /d %~dp0
set "AGENT_MINI_PYTHON=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "PYTHONUTF8=1"
start "agent-mini-bridge" "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" agent_bridge.js
timeout /t 2 /nobreak >nul
start "agent-mini-web" "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
echo WebUI: http://localhost:3000
pause