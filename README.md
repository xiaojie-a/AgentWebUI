

# Agent Web UI

一个基于 Agent-mini 开发的 Agent 智能体Web交互界面，支持实时对话、任务管理、工具调用显示等功能。

## 功能特性


 - 💬 **即时通讯**：流畅的聊天界面，支持 Markdown 渲染
 - 🔄 **任务流**：支持长任务异步处理，实时状态反馈
 - 🎨 **精美 UI**：暗色主题，流畅动画，响应式设计
 - 🔌 **双端支持**：Node.js 与 Python 后端可选  
 - :iphone:**移动端支持**:目前主力开发方向，智能体全面接管前台操作和后台复杂多任务操作。


## 其他说明

- 移动端依赖Termux作为载体，后期计划脱离载体打包为Android原生应用。
- 移动端控制许多操作仍然依赖root权限控制，后期考虑走无障碍通道。
- 目前主要维护node的桥街器，python桥街非最新版，使用可能有问题。  
- 后期为避免不必要的系统资源占用可能会将node桥接器集成到处理前端的node服务器中。

## agent-mini 定制说明（重要）

本项目依赖 [agent-mini](https://pypi.org/project/agent-mini/)，但**官方 0.3.1 直接配 AgentWebUI 会出问题**，因此仓库内提供了预先打好补丁的定制包：

📦 `agent-mini-patch/agent_mini-0.3.1+agentwebui-py3-none-any.whl`

```bash
pip install agent-mini-patch/agent_mini-0.3.1+agentwebui-py3-none-any.whl
```

### 为什么需要定制

1. **标准 Windows 上会直接崩**：官方 `config.py` 用 `open(CONFIG_FILE)` 不带 `encoding` 读取配置，而 `~/.agent-mini/config.json` 里面有中文（`systemPrompt` 等）。在 locale 编码为 cp936/GBK 的标准 Windows Python 上会抛
   `UnicodeDecodeError: 'gbk' codec can't decode byte 0xa1 ...`，WebUI 直接起不来。
2. 思考内容 `<think>…</think>` 会混进正文一起显示。
3. 工具搜索后端用的是 DuckDuckGo，国内不可达。

### 相对官方 0.3.1 的改动（共 7 个文件）

| 文件 | 改动 | 说明 |
|---|---|---|
| `config.py` | +3/-3 | `open()` 显式 `encoding="utf-8"`；`save_config` 用 `ensure_ascii=False` |
| `providers/ollama.py` | +108/-10 | 增量剥离 `<think>`（标签可跨 chunk 分片，带状态机）；新增 `on_thinking` 回调（约 160 字合批）；显式传递 `numCtx` |
| `providers/__init__.py` | +1 | `create_provider` 向 `OllamaProvider` 透传 `numCtx` |
| `agent/loop.py` | +4/-2 | `run()` 新增 `on_thinking` 参数并逐层透传 |
| `agent/context.py` | +17/-1 | 强制"思考/回复跟随用户语言"；支持 `systemPrompt` 中的 `{{CURRENT_DATE}}` / `{{CURRENT_TIME}}` 占位替换 |
| `agent/tools.py` | +152/-132 | 搜索后端由 DuckDuckGo 换为 Bing CN / Sogou / Baidu（国内可达） |
| `cli.py` | +1/-1 | `--tools` 帮助文案 |

> ⚠️ 这 7 个文件是一个整体，不能只挑几个覆盖。`providers/__init__.py` 会向 `ollama.py` 传 `num_ctx`，`agent/loop.py` 会向 `ollama.py` 传 `on_thinking`，单独替换其一会出现 `TypeError: unexpected keyword argument`。

### 从源码重建 / 回滚

```bash
# 重建：解压官方 wheel 后打补丁
pip download agent-mini==0.3.1 --no-deps -d am-dl
cd am-dl && python -c "import zipfile;zipfile.ZipFile('agent_mini-0.3.1-py3-none-any.whl').extractall('src')"
cd src && git apply -p1 ../../agent-mini-patch/agent-mini-0.3.1-agentwebui.patch

# 回滚到官方版
pip uninstall agent-mini && pip install agent-mini==0.3.1
```

补丁内容与改动统计见 `agent-mini-patch/`（含 `安装说明.txt`、`SUMMARY.txt`、`.patch`）。

> 本包基于 **0.3.1** 重建。官方若发布新版本，需要重新对 diff 并重建；agent-mini 升级后这 7 个文件的改动会丢失，需重新打补丁。

## 快速开始

### 环境要求

- Node.js >= 14 或 Python >= 3.7
- Git

### 安装与运行

#### 方式一：自动启动（推荐）

```bash
# Linux/macOS
chmod +x start.sh
./start.sh

# 或者使用 watchgod 自动重启
chmod +x watchdog.sh
./watchdog.sh
```

#### 方式二：手动启动

```bash
# 启动 Web 服务
npm install
node server.js

# 启动 Agent 桥接服务
node agent_bridge.js
# 或使用 Python
python3 agent_bridge.py
```

### 默认端口

- Web 服务：`3000`
- Agent 桥接：`8765`

## 项目结构

```
├── agent_bridge.js    # Node.js 桥接服务
├── agent_bridge.py    # Python 桥接服务
├── server.js          # Web 服务器
├── public/            # 前端资源
│   ├── index.html     # 主页面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式文件
├── agent-mini-patch/  # agent-mini 定制包（wheel + 源码补丁 + 说明）
├── start.sh           # 启动脚本
├── startnode.sh       # Node 启动脚本
├── watchdog.sh        # 进程守护
└── check_screen_cmds.sh # 屏幕控制命令检查
```

## 使用说明

1. 打开浏览器访问 `http://localhost:3000`
2. 在输入框中输入问题或指令
3. 等待 AI 助手回复
4. 可通过侧边栏管理对话历史

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | 发送消息 |
| GET | `/api/stream/:taskId` | 流式响应 |
| GET | `/api/state/:taskId` | 任务状态 |
| DELETE | `/api/stop/:taskId` | 停止任务 |
| GET | `/api/history/:sessionId` | 获取历史 |
| DELETE | `/api/session/:sessionId` | 删除会话 |

## 技术栈

- **前端**：原生 JavaScript、CSS3
- **后端**：Express.js / Python HTTP Server
- **通信**：SSE (Server-Sent Events)

## License

MIT License