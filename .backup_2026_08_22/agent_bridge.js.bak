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

        // 点亮屏幕
        ScreenController.turnOn(200);

        console.log(`[Agent] 🚀 启动任务 ${task.id}, 消息: ${message.slice(0, 50)}...`);

        // 构建 Python 脚本（传入会话历史，保证多轮上下文）
        const pythonScript = this.buildPythonScript(
            task.id, session.sessionId || 'default', message, session.conversation || []
        );

        // 启动 Python 子进程（Termux 下统一用 python3，可用 AGENT_MINI_PYTHON 覆盖）
        const pythonBin = process.env.AGENT_MINI_PYTHON || 'python3';
        const python = spawn(pythonBin, ['-c', pythonScript], {
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

        # 运行 Agent（conversation 会被 agent.run 原地追加本轮 user/assistant）
        result = await agent.run(message, conversation,
                                  on_stream=on_stream, on_tool_event=on_tool_event)

        # 先把更新后的会话上下文回传给 Node（必须在 done 之前，否则会被丢弃）
        emit({"_conversation": conversation})

        # 检查错误
        if isinstance(result, str) and (result.startswith("Error") or result.startswith("Reached maximum")):
            emit({"error": result})
        else:
            emit({"done": True, "usage": agent.turn_usage})

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

        return {
            task_id: task.id,
            status: task.status,
            content: content,
            tools: tools,
            event_count: task.events.length
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

// ============ 获取信息 ============
app.get('/info', (req, res) => {
    try {
        // 与 Python 版 load_config() 一致：读取 ~/.agent-mini/config.json
        const home = process.env.HOME || require('os').homedir();
        const configPath = process.env.AGENT_CONFIG
            || path.join(home, '.agent-mini', 'config.json');
        let provider = 'ollama';
        let model = '?';

        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            provider = config.provider || 'ollama';
            model = (config.providers || {})[provider]?.model || '?';
        }

        res.json({ provider, model });
    } catch (err) {
        res.json({ provider: 'unknown', model: 'unknown' });
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