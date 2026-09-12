#!/usr/bin/env node
/**
 * agent-mini WebUI 桥接服务（Node.js 版）
 * 
 * 功能完全兼容 Python 版本，并增加 Termux 屏幕控制支持
 * 
 * 启动: node agent-bridge.js
 * 端口: 8765 (可通过环境变量 BRIDGE_PORT 修改)
 */



const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const PORT = parseInt(process.env.BRIDGE_PORT || '8765');
const MEMORY_FILE = process.env.MEMORY_FILE || './memory.json';
// Termux 命令目录（termux-wake-lock 等都在 $PREFIX/bin 下）
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
// EffGen 后端执行器（backend=effgen 时使用）
const EFFGEN_RUNNER = path.join(__dirname, 'effgen_runner.py');

// ============ 屏幕控制开关（云端/本地模型判断） ============
// 读取 ~/.agent-mini/config.json：
//  - 当前 provider 的 baseUrl 指向公网（云端模型，如 DashScope）→ 不进行屏幕控制
//  - 指向 localhost/内网（本地模型，如 ollama）→ 正常亮屏/息屏
//  - 也可在 config.json 顶层显式设置 "screenControl": true/false 强制覆盖（agent-mini 会忽略该字段，无副作用）
const AGENT_CONFIG = path.join(process.env.HOME || '', '.agent-mini', 'config.json');

// ============ 后端引擎判断 ============
// 2026-09-07：正式放弃 EffGen（太笨重），仅保留 agent-mini 引擎。
// 无论 config 里 backend 写什么，一律返回 agent-mini；EffGen 相关分支/文件停用。
function agentBackend() {
    return 'agent-mini';
}

// EffGen 所在 Python 解释器：
//  - Windows：effgen venv（本机已装），可用 EFFGEN_PYTHON 覆盖
//  - Linux/Termux：默认 python3（需已 pip install effgen），可用 EFFGEN_PYTHON 覆盖
function effgenPythonBin() {
    if (process.env.EFFGEN_PYTHON) return process.env.EFFGEN_PYTHON;
    if (process.platform === 'win32') {
        const home = process.env.USERPROFILE || '';
        return path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'effgen', 'Scripts', 'python.exe');
    }
    return 'python3';
}

function screenControlEnabled() {
    try {
        const cfg = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf-8'));
        if (typeof cfg.screenControl === 'boolean') return cfg.screenControl;  // 显式覆盖
        const name = cfg.provider || 'ollama';
        const prov = (cfg.providers || {})[name] || {};
        const url = (prov.baseUrl || '').toLowerCase();
        // 本地地址 → 屏幕控制；公网（云端）→ 关闭
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(url);
        return isLocal;
    } catch (err) {
        return true;  // 读不到配置：默认启用（保持原行为）
    }
}

// ============ 屏幕控制 (Termux + root) ============
// 方案说明：
//  - termux-brightness / termux-screen-on 依赖 Termux:API App，本机未装且命令缺失；
//  - 改用 root 直接控制系统电源（已验证可用）：
//      亮屏: input keyevent 224 (KEYCODE_WAKEUP)
//      息屏: input keyevent 223 (KEYCODE_SLEEP)
//      常亮: svc power stayon true / false
class ScreenController {
    // 命令存在性探测（保留给 termux-wake-lock 使用）
    static cmdPath(cmd) {
        const p = path.join(PREFIX, 'bin', cmd);
        return fs.existsSync(p) ? p : cmd;
    }

    static isCmdAvailable(cmd) {
        return fs.existsSync(path.join(PREFIX, 'bin', cmd));
    }

    /**
     * 安全执行 Termux 自带命令（如 termux-wake-lock）。
     * 命令不存在（ENOENT）时仅告警，绝不抛未处理异常。
     */
    static runCmd(cmd, args) {
        try {
            const child = spawn(this.cmdPath(cmd), args, { stdio: 'ignore' });
            child.on('error', (err) => {
                console.warn(`[Screen] 命令不可用，已忽略: ${cmd} (${err.code})`);
            });
            return child;
        } catch (err) {
            console.warn(`[Screen] 命令启动失败，已忽略: ${cmd} (${err.message})`);
            return null;
        }
    }

    static isTermux() {
        return process.platform === 'android' || !!process.env.TERMUX;
    }

    /**
     * 以 root 执行系统命令（su -c）。
     * - su 不存在/被拒：仅告警，绝不抛未处理异常
     * - 首次调用失败会标记 rootBroken，后续直接跳过（避免每个任务重复尝试）
     */
    static runAsRoot(cmdline) {
        if (this.rootBroken) return null;
        try {
            const child = spawn('su', ['-c', cmdline], { stdio: 'ignore' });
            child.on('error', (err) => {
                this.rootBroken = true;
                console.warn(`[Screen] su 不可用，已禁用 root 屏幕控制 (${err.code})`);
            });
            child.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    this.rootBroken = true;
                    console.warn(`[Screen] root 命令执行失败，已禁用: ${cmdline} (code=${code})`);
                }
            });
            return child;
        } catch (err) {
            this.rootBroken = true;
            console.warn(`[Screen] root 命令启动失败: ${err.message}`);
            return null;
        }
    }

    /** 亮屏（KEYCODE_WAKEUP=224） */
    static wakeScreen() {
        this.runAsRoot('input keyevent 224');
    }

    /** 息屏（KEYCODE_SLEEP=223） */
    static sleepScreen() {
        this.runAsRoot('input keyevent 223');
    }

    /** 保持屏幕常亮 / 恢复自动熄屏（svc power stayon） */
    static keepAwake(on) {
        this.runAsRoot(`svc power stayon ${on ? 'true' : 'false'}`);
    }

    /** 任务开始：亮屏 + 防熄屏 + 唤醒锁 */
    static turnOn() {
        if (!this.enabled) {
            console.log('[Screen] ⏭ 云端模型，跳过屏幕控制（不亮屏）');
            return;
        }
        if (!this.isTermux()) return;

        // 1) 亮屏（root，真实可见效果）
        this.wakeScreen();
        // 2) 保持常亮（root，防生成任务时熄屏）
        this.keepAwake(true);
        // 3) 唤醒锁（termux-tools 自带，防 CPU 休眠，无需 root/API App）
        if (this.isCmdAvailable('termux-wake-lock')) {
            this.runCmd('termux-wake-lock', []);
        }

        console.log('[Screen] ✅ 已亮屏并保持常亮（root）');
    }

    /** 任务结束：立即息屏 + 恢复自动熄屏设置 + 释放唤醒锁 */
    static turnOff() {
        if (!this.enabled) return;
        if (!this.isTermux()) return;

        // 1) 恢复系统自动熄屏设置
        this.keepAwake(false);
        // 2) 释放唤醒锁
        if (this.isCmdAvailable('termux-wake-unlock')) {
            this.runCmd('termux-wake-unlock', []);
        }
        // 3) 任务结束立即息屏（省电；结果已由前端通知，可随时点亮查看）
        this.sleepScreen();

        console.log('[Screen] ✅ 已息屏并恢复自动熄屏');
    }
}
// root 不可用时缓存禁用（避免每个任务重复尝试）
ScreenController.rootBroken = false;
// 屏幕控制总开关：每次任务前由 screenControlEnabled() 按模型类型刷新
ScreenController.enabled = true;

// ============ Agent 管理器 ============
class AgentManager {
    constructor() {
        this.sessions = new Map();  // session_id -> { conversation: [], lock: false, worker: null }
        this.tasks = new Map();     // task_id -> task object
        this.tasksGuard = false;
    }

    /**
     * 获取或创建会话
     */
    getSession(sessionId) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                conversation: [],
                lock: false,
                worker: null
            });
        }
        return this.sessions.get(sessionId);
    }

    /**
     * 创建新任务
     */
    createTask(sessionId, taskId = null) {
        // 如果 taskId 已存在，自动生成新 ID
        if (taskId && this.tasks.has(taskId)) {
            taskId = null;
        }
        taskId = taskId || uuidv4().replace(/-/g, '');

        const task = {
            id: taskId,
            sessionId: sessionId,
            status: 'running',
            events: [],
            subscribers: [],
            cancelFlag: false,
            startTime: Date.now(),
            worker: null
        };

        this.tasks.set(taskId, task);
        return task;
    }

    /**
     * 获取任务
     */
    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }

    /**
     * 取消任务
     */
    cancelTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        task.cancelFlag = true;
        // 如果 worker 还在运行，发送 SIGINT
        if (task.worker && !task.worker.killed) {
            task.worker.kill('SIGINT');
        }
        return true;
    }

    /**
     * 取消会话的所有任务
     */
    cancelSessionTasks(sessionId) {
        const cancelled = [];
        for (const [taskId, task] of this.tasks) {
            if (task.sessionId === sessionId) {
                this.cancelTask(taskId);
                cancelled.push(taskId);
            }
        }
        return cancelled;
    }

    /**
     * 停止所有正在运行的任务（SIGINT + 3 秒后未退则 SIGKILL，确保彻底停止）
     */
    stopAllTasks() {
        const stopped = [];
        for (const [taskId, task] of this.tasks) {
            if (task.status === 'running') {
                this.cancelTask(taskId);
                stopped.push(taskId);
            }
        }
        // 兜底：SIGINT 3 秒内仍 running 则 SIGKILL，防止卡死的 python/推理子进程赖着不走
        for (const taskId of stopped) {
            const task = this.tasks.get(taskId);
            if (!task || !task.worker) continue;
            setTimeout(() => {
                const t = this.tasks.get(taskId);
                if (t && t.status === 'running' && t.worker && !t.worker.killed) {
                    console.log(`[Agent] 任务 ${taskId} 停止超时，强制 SIGKILL`);
                    t.worker.kill('SIGKILL');
                }
            }, 3000);
        }
        return stopped;
    }

    /**
     * 删除会话
     */
    deleteSession(sessionId) {
        // 取消所有任务
        this.cancelSessionTasks(sessionId);
        // 删除会话
        return this.sessions.delete(sessionId);
    }

    /**
     * 启动 Agent 任务（在后台运行 Python agent-mini）
     */
    startAgent(task, session, message) {
        // 获取会话锁（串行执行）
        if (session.lock) {
            console.log(`[Agent] 会话 ${session.sessionId || 'default'} 正在处理，拒绝新请求`);
            return false;
        }
        session.lock = true;

        // 根据模型类型刷新屏幕控制开关（云端模型不亮屏，本地模型正常控制）
        ScreenController.enabled = screenControlEnabled();
        // 点亮屏幕
        ScreenController.turnOn();

        console.log(`[Agent] 🚀 启动任务 ${task.id}, 消息: ${message.slice(0, 50)}...`);

        // 后端引擎：agent-mini（内嵌 Python 脚本）或 effgen（effgen_runner.py）
        const backend = agentBackend();
        const sessionId = session.sessionId || 'default';
        let pythonBin;
        let pythonArgs;

        if (backend === 'effgen') {
            // EffGen：独立 runner 文件，参数 base64 传递，协议与内嵌脚本一致
            pythonBin = effgenPythonBin();
            pythonArgs = [
                EFFGEN_RUNNER,
                task.id, sessionId,
                Buffer.from(message).toString('base64'),
                Buffer.from(JSON.stringify(session.conversation || [])).toString('base64')
            ];
        } else {
            // agent-mini：内嵌 Python 脚本（传入会话历史，保证多轮上下文）
            const pythonScript = this.buildPythonScript(
                task.id, sessionId, message, session.conversation || []
            );
            // 启动 Python 子进程（Termux 下统一用 python3，可用 AGENT_MINI_PYTHON 覆盖）
            pythonBin = process.env.AGENT_MINI_PYTHON || 'python3';
            pythonArgs = ['-c', pythonScript];
        }
        const python = spawn(pythonBin, pythonArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        task.worker = python;

        // 处理 Python 输出（SSE 事件）
        let buffer = '';
        python.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留不完整的行

            for (const line of lines) {
                if (line.trim().startsWith('data: ')) {
                    try {
                        const jsonStr = line.trim().substring(6); // 去掉 "data: "
                        const event = JSON.parse(jsonStr);
                        // Python 子进程回传的会话上下文：仅更新会话，不转发给前端
                        if (event._conversation) {
                            session.conversation = event._conversation;
                            continue;
                        }
                        this.emitEvent(task, event);
                    } catch (err) {
                        console.error('[Agent] 解析事件失败:', err.message);
                    }
                }
            }
        });

        // 处理错误输出
        python.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                console.error('[Agent] stderr:', msg);
                // 如果是错误信息，发送给前端
                if (msg.includes('Error') || msg.includes('Exception')) {
                    this.emitEvent(task, { error: msg });
                }
            }
        });

        // 进程结束
        python.on('close', (code) => {
            console.log(`[Agent] 任务 ${task.id} 结束，退出码: ${code}`);
            
            // 检查是否有未处理的 buffer
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer.trim());
                    this.emitEvent(task, event);
                } catch (err) {
                    // 忽略
                }
            }

            // 如果任务还没有完成，标记为完成（用户取消则标记为 cancelled，而不是假 done）
            if (task.status === 'running') {
                this.emitEvent(task, task.cancelFlag ? { cancelled: true } : { done: true });
            }

            // 清理
            task.status = 'done';
            session.lock = false;
            
            // 释放屏幕锁
            ScreenController.turnOff();
        });

        // 进程错误
        python.on('error', (err) => {
            console.error(`[Agent] 任务 ${task.id} 启动失败:`, err.message);
            this.emitEvent(task, { error: `Agent 启动失败: ${err.message}` });
            task.status = 'error';
            session.lock = false;
            ScreenController.turnOff();
        });

        return true;
    }

    /**
     * 构建 Python 脚本（用于子进程执行）
     * @param {string} taskId
     * @param {string} sessionId
     * @param {string} message
     * @param {Array} conversation 会话历史，保证多轮对话上下文
     */
    buildPythonScript(taskId, sessionId, message, conversation) {
        // base64 传递，避免引号/反斜杠/换行等导致 Python 源码语法错误或注入
        const messageB64 = Buffer.from(message).toString('base64');
        const conversationB64 = Buffer.from(JSON.stringify(conversation || [])).toString('base64');
        return `
import asyncio
import base64
import json
import sys
import os
import time
from agent_mini.config import load_config, MEMORY_FILE
from agent_mini.providers import create_provider
from agent_mini.agent import AgentLoop, Memory

# 输出 SSE 格式
def emit(event):
    line = "data: " + json.dumps(event, ensure_ascii=False)
    print(line, flush=True)

async def main():
    try:
        config = load_config()
        provider = create_provider(config)
        memory = Memory(MEMORY_FILE, max_entries=config.get("memory", {}).get("maxEntries", 1000))

        # [精确Token] 包装 provider，记录最后一次 LLM 调用的真实 usage
        # turn_usage 是累加值（多轮工具调用会重复计算历史），
        # 而最后一次调用的 prompt_tokens 才是当前会话的真实上下文用量。
        _last_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        class _UsageTracker:
            def __init__(self, inner):
                self._inner = inner
            @property
            def name(self):
                return self._inner.name
            @property
            def model_name(self):
                return self._inner.model_name
            async def chat(self, messages, tools=None, temperature=0.7):
                resp = await self._inner.chat(messages, tools=tools, temperature=temperature)
                if getattr(resp, "usage", None):
                    _last_usage.update(resp.usage)
                return resp
            async def chat_stream(self, messages, on_delta, tools=None, temperature=0.7, on_thinking=None):
                resp = await self._inner.chat_stream(messages, on_delta, tools=tools, temperature=temperature, on_thinking=on_thinking)
                if getattr(resp, "usage", None):
                    _last_usage.update(resp.usage)
                return resp
            async def close(self):
                await self._inner.close()
        provider = _UsageTracker(provider)

        agent = AgentLoop(provider, config, memory)

        # 从 base64 还原消息与会话历史（Node 侧传入，防注入）
        message = base64.b64decode("${messageB64}").decode("utf-8")
        conversation = json.loads(base64.b64decode("${conversationB64}").decode("utf-8"))

        # 回调：流式输出
        async def on_stream(delta):
            emit({"content": delta})

        # 回调：工具事件
        async def on_tool_event(ev):
            emit({
                "tool": {
                    "name": ev.name,
                    "arguments": ev.arguments or {},
                    "result_preview": ev.result_preview or "",
                    "is_error": ev.is_error,
                    "duration": ev.duration,
                }
            })

        # 深度思考：agent-mini 剥离的 <think> 内容经 on_thinking 实时转发前端面板
        async def on_thinking(text):
            if text:
                emit({"reasoning": text})

        # 运行 Agent（conversation 会被 agent.run 原地追加本轮 user/assistant）
        result = await agent.run(message, conversation,
                                  on_stream=on_stream, on_tool_event=on_tool_event,
                                  on_thinking=on_thinking)

        # 先把更新后的会话上下文回传给 Node（必须在 done 之前，否则会被丢弃）
        emit({"_conversation": conversation})

        # 检查错误
        if isinstance(result, str) and (result.startswith("Error") or result.startswith("Reached maximum")):
            emit({"error": result})
        else:
            emit({"done": True, "usage": agent.turn_usage, "last_prompt_tokens": _last_usage["prompt_tokens"]})

        await agent.close()

    except asyncio.CancelledError:
        emit({"cancelled": True})
    except KeyboardInterrupt:
        emit({"cancelled": True})
    except Exception as e:
        emit({"error": f"{type(e).__name__}: {e}"})

asyncio.run(main())
`;
    }

    /**
     * 发送事件到任务缓冲区并广播给订阅者
     */
    emitEvent(task, event) {
        if (!task || task.status !== 'running') return;

        // 推进任务状态，避免进程退出时 close 兜底重复发 done
        if (event.done) task.status = 'done';
        else if (event.error) task.status = 'error';
        else if (event.cancelled) task.status = 'cancelled';

        // 添加到事件列表
        task.events.push(event);

        // 广播给所有订阅者
        for (const subscriber of task.subscribers) {
            try {
                subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch (err) {
                // 订阅者可能已断开
            }
        }
    }

    /**
     * 获取任务状态
     */
    getTaskState(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return null;

        const content = task.events
            .filter(e => e.content)
            .map(e => e.content)
            .join('');

        const tools = task.events
            .filter(e => e.tool)
            .map(e => e.tool);

        // [精确Token] 从 done 事件中提取真实 usage 数据
        const doneEvent = task.events.filter(e => e.done).pop();
        const usage = doneEvent && doneEvent.usage ? doneEvent.usage : null;
        const last_prompt_tokens = doneEvent && doneEvent.last_prompt_tokens ? doneEvent.last_prompt_tokens : 0;

        return {
            task_id: task.id,
            status: task.status,
            content: content,
            tools: tools,
            event_count: task.events.length,
            usage: usage,
            last_prompt_tokens: last_prompt_tokens
        };
    }
}

// ============ Express 应用 ============
const app = express();
const manager = new AgentManager();

app.use(bodyParser.json({ limit: '10mb' }));

// ============ 中间件：CORS ============
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

// ============ 健康检查 ============
app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});

// ============ 配置文件路径 ============
function getConfigPath() {
    const home = process.env.HOME || require('os').homedir();
    return process.env.AGENT_CONFIG || path.join(home, '.agent-mini', 'config.json');
}

// 读取配置（文件不存在时返回 null）
function readConfig() {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return null; }
}

// ============ 获取信息 ============
app.get('/info', (req, res) => {
    try {
        const config = readConfig();
        let provider = 'ollama';
        let model = '?';
        let numCtx = 8192;
        if (config) {
            provider = config.provider || 'ollama';
            const prov = (config.providers || {})[provider] || {};
            model = prov.model || '?';
            const n = parseInt(prov.numCtx, 10);
            if (n && n > 0) numCtx = n;
        }
        res.json({ provider, model, numCtx, backend: agentBackend() });
    } catch (err) {
        res.json({ provider: 'unknown', model: 'unknown', numCtx: 8192, backend: agentBackend() });
    }
});

// ============ 列出可用模型 ============
// 返回所有可选模型供前端下拉框填充：
//   1) config 里已配置的 providers（local/云端等，始终列出）
//   2) **自动检测 ollama 本地模型**（GET {baseUrl}/api/tags）—— 本机 ollama 里
//      pull 进来的模型（qwen3:1.7b / orca-mini / granite 等）全部加入 ollama 组，
//      无需每次手动写 config。cloud 型模型排到列表末尾。
// 切换仍走 POST /config（provider=ollama + 任意模型名即写入生效）。
app.get('/models', async (req, res) => {
    try {
        const config = readConfig();
        if (!config) {
            return res.json({ active: 'ollama', models: [] });
        }
        const active = config.provider || 'ollama';
        const providers = config.providers || {};
        const seen = new Set();
        const models = [];
        const push = (provider, model, isActive) => {
            const key = provider + '||' + model;
            if (!model || seen.has(key)) return;
            seen.add(key);
            models.push({ provider, model, active: !!isActive });
        };

        // 1) 已配置 providers（含 local/云端 API）
        for (const name of Object.keys(providers)) {
            const cfg = providers[name] || {};
            if (cfg && cfg.model) push(name, cfg.model, name === active);
        }

        // 2) 自动检测 ollama 本地模型
        const ollamaCfg = providers.ollama || {};
        const ollamaUrl = String(ollamaCfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        const activeModel = (providers.ollama && providers.ollama.model) || '';
        let localCount = 0;
        try {
            const r = await fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                const tags = await r.json();
                const list = Array.isArray(tags && tags.models) ? tags.models : [];
                const sorted = list.slice().sort((a, b) => {
                    const ac = String(a && a.name || '').toLowerCase().includes('cloud') ? 1 : 0;
                    const bc = String(b && b.name || '').toLowerCase().includes('cloud') ? 1 : 0;
                    return ac - bc;
                });
                for (const m of sorted) {
                    const name = String((m && m.name) || '').trim();
                    if (!name) continue;
                    localCount++;
                    push('ollama', name, active === 'ollama' && name === activeModel);
                }
            }
        } catch (e) { /* ollama 不可达：忽略，仍返回已配置项 */ }

        // 3) 兜底：ollama 探测失败时至少保留当前配置项
        if (localCount === 0) push('ollama', activeModel || 'qwen3:8b', active === 'ollama');

        res.json({ active, models, local_models: localCount });
    } catch (err) {
        res.json({ active: 'ollama', models: [], error: err.message });
    }
});

// ============ 切换模型 / 后端 ============
// body 支持三种用法：
//   1) { provider, model } —— 切换模型（原逻辑，只在已有 provider 间切）
//   2) { backend: "effgen"|"agent-mini" } —— 切换后端引擎（顶层字段）
//   3) 两者同时 —— 先切后端再切模型
app.post('/config', (req, res) => {
    try {
        const { provider, model, backend, numCtx } = req.body || {};
        const config = readConfig();
        if (!config) {
            return res.status(500).json({ error: '配置文件不存在或无法读取' });
        }
        config.providers = config.providers || {};

        // 后端引擎：2026-09-07 起仅支持 agent-mini（EffGen 已弃用，写 effgen 一律回落到 agent-mini）
        if (backend !== undefined && backend !== null) {
            const b = String(backend).trim();
            if (b !== 'agent-mini' && b !== 'effgen') {
                return res.status(400).json({ error: `未知的 backend: ${backend}（仅支持 agent-mini）` });
            }
            if (b === 'effgen') {
                console.warn('[Config] EffGen 已弃用，忽略 backend=effgen，保持 agent-mini');
            }
            config.backend = 'agent-mini';
            console.log('[Config] 后端引擎：agent-mini');
        }

        const providers = config.providers || {};
        if (provider && providers[provider]) {
            // 切换 provider
            config.provider = provider;
            // 如果指定了模型且非空，更新对应 provider 的 model
            if (model && String(model).trim()) {
                providers[provider].model = String(model).trim();
            }
        }

        // 上下文最大值 numCtx：写入对应 provider（未指定 provider 时用当前 provider）
        if (numCtx !== undefined && numCtx !== null) {
            const target = (provider && providers[provider]) ? provider : config.provider;
            const n = parseInt(numCtx, 10);
            if (n && n >= 512 && n <= 131072) {
                providers[target].numCtx = n;
                console.log(`[Config] ${target} 上下文上限 -> ${n}`);
            }
        }

        // 写回
        const configPath = getConfigPath();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        const newModel = (providers[config.provider] && providers[config.provider].model) || '?';
        const newNumCtx = parseInt(providers[config.provider] && providers[config.provider].numCtx, 10) || 8192;
        console.log(`[Config] 模型已切换 -> ${config.provider} / ${newModel}`);
        res.json({ ok: true, provider: config.provider, model: newModel, numCtx: newNumCtx, backend: config.backend || 'agent-mini' });
    } catch (err) {
        res.status(500).json({ error: `切换失败: ${err.message}` });
    }
});

// ============ 创建聊天任务 ============
// 注意：路径必须与 server.js 转发的一致（无 /api 前缀），
// 否则 server.js 代理 /chat 会命中 404 兜底，前端报 "not found"。
app.post('/chat', (req, res) => {
    const { message, session_id, task_id } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    const sessionId = (session_id || 'default').trim();
    const taskId = (task_id || '').trim() || null;

    // 获取会话
    const session = manager.getSession(sessionId);
    // 给 session 添加 sessionId 用于日志
    session.sessionId = sessionId;

    // 检查会话锁
    if (session.lock) {
        return res.status(409).json({ 
            error: '该会话正在生成回复，请稍候',
            session_id: sessionId
        });
    }

    // 创建任务
    const task = manager.createTask(sessionId, taskId);

    // 启动 Agent（异步）
    const started = manager.startAgent(task, session, message.trim());
    if (!started) {
        // 如果启动失败（理论上不会发生，因为已经检查了锁）
        manager.tasks.delete(task.id);
        return res.status(500).json({ error: '启动 Agent 失败' });
    }

    res.json({
        task_id: task.id,
        status: 'running',
        session_id: sessionId
    });
});

// ============ SSE 流 ============
app.get('/task/:id/stream', (req, res) => {
    const taskId = req.params.id;
    const task = manager.getTask(taskId);

    if (!task) {
        return res.status(404).json({ error: 'task not found' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲

    // 发送已存在的事件（重放）
    for (const event of task.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // 如果任务已完成，直接结束
    if (task.status !== 'running') {
        res.end();
        return;
    }

    // 注册为订阅者
    task.subscribers.push(res);

    // 心跳保活（每 15 秒发送注释）
    const heartbeat = setInterval(() => {
        if (task.status !== 'running') {
            clearInterval(heartbeat);
            return;
        }
        try {
            res.write(': ping\n\n');
        } catch (err) {
            clearInterval(heartbeat);
        }
    }, 15000);

    // 客户端断开时清理
    req.on('close', () => {
        clearInterval(heartbeat);
        const index = task.subscribers.indexOf(res);
        if (index !== -1) {
            task.subscribers.splice(index, 1);
        }
        console.log(`[SSE] 客户端断开连接: task ${taskId}`);
    });
});

// ============ 获取任务状态 ============
app.get('/task/:id/state', (req, res) => {
    const taskId = req.params.id;
    const state = manager.getTaskState(taskId);

    if (!state) {
        return res.status(404).json({ error: 'task not found' });
    }

    res.json(state);
});

// ============ 取消任务 ============
app.post('/cancel', (req, res) => {
    const { task_id, session_id } = req.body;

    if (task_id) {
        const cancelled = manager.cancelTask(task_id);
        return res.json({ ok: true, cancelled, task_id });
    }

    if (session_id) {
        const cancelled = manager.cancelSessionTasks(session_id);
        return res.json({ ok: true, cancelled, session_id, count: cancelled.length });
    }

    res.status(400).json({ error: 'task_id or session_id required' });
});

// ============ 停止所有任务（前端“停止所有任务”按钮） ============
app.post('/stop-all', (req, res) => {
    const stopped = manager.stopAllTasks();
    res.json({ ok: true, stopped, count: stopped.length });
});

// ============ 删除会话 ============
app.delete('/session/:id', (req, res) => {
    const sessionId = req.params.id;
    const deleted = manager.deleteSession(sessionId);
    res.json({ ok: true, deleted, session_id: sessionId });
});

// ============ 404 处理 ============
app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
});

// ============ 启动服务 ============
app.listen(PORT, '127.0.0.1', () => {
    console.log(`
╔════════════════════════════════════════════════╗
║  agent-mini bridge (Node.js) 已启动           ║
╠════════════════════════════════════════════════╣
║  地址: http://127.0.0.1:${PORT}                ║
║  环境: ${process.platform}                     ║
║  屏幕控制: ${process.platform === 'android' ? '✅ 已启用' : '❌ 仅 Termux 可用'} ║
╚════════════════════════════════════════════════╝
    `);
});

// ============ 优雅退出 ============
process.on('SIGINT', () => {
    console.log('\n[Shutdown] 正在关闭...');
    // 释放所有屏幕锁
    ScreenController.turnOff();
    // 取消所有任务
    for (const [taskId, task] of manager.tasks) {
        if (task.worker && !task.worker.killed) {
            task.worker.kill('SIGINT');
        }
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    process.exit(0);
});