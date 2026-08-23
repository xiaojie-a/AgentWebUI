

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