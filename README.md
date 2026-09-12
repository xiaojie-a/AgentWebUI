

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

本项目依赖 [agent-mini](https://pypi.org/project/agent-mini/)，但**官方 0.3.1 配合 AgentWebUI 在任何操作系统上都无法使用**，因此仓库内提供了预先打好补丁的定制包：

📦 `agent-mini-patch/agent_mini-0.3.1+agentwebui.2-py3-none-any.whl`

```bash
pip install agent-mini-patch/agent_mini-0.3.1+agentwebui.2-py3-none-any.whl
# 已装过旧定制版（+agentwebui / .1）时用：
pip install --force-reinstall --no-deps agent-mini-patch/agent_mini-0.3.1+agentwebui.2-py3-none-any.whl
```

### 为什么需要定制

> ⚠️ **根本原因是 API 不匹配，不是编码问题——Windows / Linux / Termux / macOS 一视同仁。**

**1️⃣ 硬崩，全平台（必须用定制版的原因）**

`agent_bridge.js:495-497` 这样调用 agent-mini：

```python
result = await agent.run(message, conversation,
                          on_stream=on_stream, on_tool_event=on_tool_event,
                          on_thinking=on_thinking)
```

而官方 0.3.1 的 `AgentLoop.run()` 签名是
`(user_message, conversation, on_stream=None, on_tool_event=None) -> str`——**没有 `on_thinking`**。

于是**每一条消息发出后立刻失败**：

```
TypeError: AgentLoop.run() got an unexpected keyword argument 'on_thinking'
```

该异常被 bridge 的 `except Exception` 捕获，以 `{"error": "TypeError: ..."}` 推给前端，表现为"消息一发就报错"。

- 已在 **Ubuntu + Python 3.14.4 + 官方 `pip`/`pipx` 安装版**上实测复现（`xem` 机器）。
- 该依赖由 **`6a246f8`（2026-09-10「更新ui」）** 引入，在那之前的版本配官方包可以正常运行。
- 与操作系统、locale、文件编码**完全无关**。

**2️⃣ Windows 专属的额外一层崩溃**

官方 `config.py:126` 用 `open(CONFIG_FILE)` 不带 `encoding`，走系统默认编码。在 locale 为 cp936/GBK 的标准 Windows Python 上，读取含中文（`systemPrompt` 等）的 `~/.agent-mini/config.json` 会抛
`UnicodeDecodeError: 'gbk' codec can't decode byte 0xa1 ...`。

> 注意：**这一条只在"系统默认编码非 UTF-8"时成立**。Ubuntu 默认 `LANG=zh_CN.UTF-8`，所以在 Linux 上它不会发作——不要把它当成万能解释。

**3️⃣ `numCtx` 被静默丢弃（不报错，但设置是假的）**

官方 `providers/__init__.py` 构造 `OllamaProvider` 时不传 `num_ctx`，于是 WebUI 设置面板里的"上下文长度"以及 `config.json` 里的 `numCtx` **完全不会生效**。

**4️⃣ `<think>…</think>` 会混进正文一起显示。**

**5️⃣ 工具搜索后端用的是 DuckDuckGo，国内不可达。**

**6️⃣ 上下文用量只能显示"(估算)"（静默降级，不报错）**

官方 `providers/ollama.py` 只在**非流式** `chat()` 里把 `prompt_eval_count` / `eval_count` 填进 `ChatResponse.usage`；WebUI 默认走的**流式** `chat_stream()` 直接 `return ChatResponse(content=..., tool_calls=..., thinking=...)`，**不带 `usage`**。

于是 bridge 的 `[精确Token]` 永远取到 `None`，前端"已用上下文"只能标 `(估算)`，也不会出现「本轮生成 / 本轮总计」两行。

patch 在流式 chunk 循环里记录 `prompt_eval_count` / `eval_count`（ollama 在最后一个 `done` chunk 给出），返回时构造 `usage` 交给 `ChatResponse`。
实测（xem / Ubuntu / qwen3:1.7b）：直接调 provider 得 `{'prompt_tokens': 16, 'completion_tokens': 182}`；走 bridge 全链路得 `last_prompt_tokens=1851`（真实系统提示量）。

> 这一条与 1️⃣ 无关——缺它不会崩，只是前端静默退回估算值。但 **`agent_bridge.js` / `public/app.js` 已带 `[精确Token]` 逻辑，装旧包就会看到假数字**。

**7️⃣ "有效上下文 / 压缩阈值"被钉死在模型档位，跟 numCtx 脱钩**

官方 `agent/token_estimator.py` 把"有效上下文"按模型档位写死：
`tiny=3000 / small=6000 / medium=12000 / cloud=32000`；
`agent/loop.py` 在会话用量超过 `有效上下文 × 0.75` 时触发摘要压缩（压缩目标 `× 0.5`）。

后果：**前端滑杆把 `numCtx` 调到 35840，压缩仍然在 6000×0.75=4500 就触发**——UI 上"窗口上限"是假的，实际可用上下文和配的完全无关。

patch 让 `AgentLoop` 优先读取 `config.providers.<当前 provider>.numCtx` 作为有效上下文（读不到才回退档位默认值），并把压缩比例抽成可配：

```jsonc
// ~/.agent-mini/config.json
{
  "providers": { "ollama": { "model": "qwen3:8b", "numCtx": 8192 } },
  "agent": {
    "maxIterations": 50,
    "compactRatio": 0.75,        // 可选：达到 numCtx×此值触发摘要（默认 0.75）
    "compactTargetRatio": 0.5    // 可选：压缩后目标水位（默认 0.5）
  }
}
```

联动方向：**前端「上下文用量」弹窗滑杆 → `POST /api/config` → `config.numCtx` → 后端下一条消息生效**（bridge 每个任务都重新 `load_config()` 建 `AgentLoop`，**不用重启服务**）。弹窗里会同步显示推导出的「有效上下文」与「压缩阈值」。

| numCtx | 有效上下文 | 压缩阈值（0.75） |
|---|---|---|
| 5120 | 5120 | 3840 |
| 8192 | 8192 | 6144 |
| 35840 | 35840 | 26880 |
| 未设置 | 按档位（8B→6000） | 4500 |

### 相对官方 0.3.1 的改动（共 7 个文件）

| 文件 | 改动 | 说明 |
|---|---|---|
| `config.py` | +3/-3 | `open()` 显式 `encoding="utf-8"`；`save_config` 用 `ensure_ascii=False`（修上面 2️⃣） |
| `providers/ollama.py` | +126/-11 | ①增量剥离 `<think>`（标签可跨 chunk 分片，带状态机）+ `on_thinking` 回调（约 160 字合批）+ 显式传递 `numCtx`（修 3️⃣4️⃣）；②**流式路径提取真实 `usage`**（修 6️⃣） |
| `providers/__init__.py` | +1 | `create_provider` 向 `OllamaProvider` 透传 `numCtx` |
| `agent/loop.py` | +62/-7 | ①**`run()` 新增 `on_thinking` 参数并逐层透传（修 1️⃣，bridge 硬依赖）**；②**有效上下文改为读 `numCtx` + 压缩比例可配（修 7️⃣）** |
| `agent/context.py` | +17/-1 | 强制"思考/回复跟随用户语言"；支持 `systemPrompt` 中的 `{{CURRENT_DATE}}` / `{{CURRENT_TIME}}` 占位替换 |
| `agent/tools.py` | +152/-132 | 搜索后端由 DuckDuckGo 换为 Bing CN / Sogou / Baidu（修 5️⃣，国内可达） |
| `cli.py` | +1/-1 | `--tools` 帮助文案 |

> ⚠️ 这 7 个文件是一个整体，不能只挑几个覆盖。
> - **`agent/loop.py` + `providers/ollama.py` 是 `on_thinking` 通路的两端**，bridge 靠它把思考内容推给前端；只装其一仍会 `TypeError`。
> - `providers/__init__.py` 会向 `ollama.py` 传 `num_ctx`，单独替换其一会出现 `TypeError: unexpected keyword argument`。

### 一条命令自查：装的是官方版还是定制版

```bash
python -c "import inspect, agent_mini.agent as a; \
print('OK 定制版' if 'on_thinking' in inspect.signature(a.AgentLoop.run).parameters else 'X 官方版 —— 必须换成定制包')"
```

> `pipx` 用户请用 `~/.local/share/pipx/venvs/agent-mini/bin/python` 执行同一段代码。

再查 `[精确Token]` 补丁在不在（不需要 ollama 在跑）：

```bash
python -c "import inspect; from agent_mini.providers.ollama import OllamaProvider; \
s=inspect.getsource(OllamaProvider.chat_stream); \
print('OK 带精确Token' if 'prompt_eval_count' in s and 'usage=_usage' in s else 'X 缺精确Token —— 前端只会显示(估算)')"
```

想跑真实推理验证全链路：`agent-mini-patch/verify_precise_token.py`
（A：直接调 `provider.chat_stream` 看 `usage`；B：走 `/chat` → `/task/<id>/state` 看 `last_prompt_tokens`；两条都 PASS 才算通）。

再查 7️⃣ 的"有效上下文是否跟随 numCtx"（不需要 ollama 在跑）：

```bash
python agent-mini-patch/verify_numctx_linkage.py
```

会打印一组「配置 numCtx → 实际生效的有效上下文 / 压缩阈值」对照；
若 `numCtx=35840` 那行显示 `6000 / 4500`，说明装的还是旧包。

### 从源码重建 / 回滚

```bash
# 重建：解压官方 wheel 后打补丁
pip download agent-mini==0.3.1 --no-deps -d am-dl
cd am-dl && python -c "import zipfile;zipfile.ZipFile('agent_mini-0.3.1-py3-none-any.whl').extractall('src')"
cd src && git apply -p1 ../../agent-mini-patch/agent-mini-0.3.1-agentwebui.patch

# 回滚到官方版（注意：装回官方版后 WebUI 将无法使用，见上文 1️⃣）
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