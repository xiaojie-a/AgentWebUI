# Agent Web UI

A web-based intelligent Agent interaction interface, supporting features such as real-time conversation, task management, device control, and more.

## Features

- 💬 **Real-time Chat**: Smooth chat interface, supports Markdown rendering
- 🔄 **Task Flow**: Supports long-running task asynchronous processing, real-time status feedback
- 📱 **Device Control**: Screen on/off, wake-up, and other control functions
- 🎨 **Polished UI**: Dark theme, smooth animations, responsive design
- 🔌 **Dual Backend Support**: Node.js and Python backends available

## Quick Start

### Requirements

- Node.js >= 14 or Python >= 3.7
- Git

### Installation & Running

#### Method 1: Auto Start (Recommended)

```bash
# Linux/macOS
chmod +x start.sh
./start.sh

# Or use watchgod for auto-restart
chmod +x watchdog.sh
./watchdog.sh
```

#### Method 2: Manual Start

```bash
# Start Web Service
npm install
node server.js

# Start Agent Bridge Service
node agent_bridge.js
# Or use Python
python3 agent_bridge.py
```

### Default Ports

- Web Service: `3000`
- Agent Bridge: `8080`

## Project Structure

```
├── agent_bridge.js    # Node.js Bridge Service
├── agent_bridge.py    # Python Bridge Service
├── server.js          # Web Server
├── public/            # Frontend Resources
│   ├── index.html     # Main Page
│   ├── app.js         # Frontend Logic
│   └── style.css      # Stylesheet
├── start.sh           # Startup Script
├── startnode.sh       # Node Startup Script
├── watchdog.sh        # Process Guardian
└── check_screen_cmds.sh # Screen Control Command Check
```

## Usage Instructions

1. Open a browser and access `http://localhost:3000`
2. Enter questions or commands in the input box
3. Wait for the AI Assistant to reply
4. Manage chat history via the sidebar

## API Interface

| Method | Path | Description |
|------|------|------|
| POST | `/api/chat` | Send message |
| GET | `/api/stream/:taskId` | Streaming response |
| GET | `/api/state/:taskId` | Task status |
| DELETE | `/api/stop/:taskId` | Stop task |
| GET | `/api/history/:sessionId` | Get history |
| DELETE | `/api/session/:sessionId` | Delete session |

## Tech Stack

- **Frontend**: Native JavaScript, CSS3
- **Backend**: Express.js / Python HTTP Server
- **Communication**: SSE (Server-Sent Events)

## License

MIT License