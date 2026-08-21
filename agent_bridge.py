# -*- coding: utf-8 -*-
"""
agent-mini WebUI 桥接服务（任务化 + 断点续传版）

把 agent-mini 的 Python API（AgentLoop）包装成本地 HTTP/SSE 服务，
供 Node 后端（server.js）代理调用。必须在安装了 agent-mini 的 Python
环境中运行，例如：

    C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\agent-mini\\Scripts\\python.exe agent_bridge.py

接口（默认端口 8765，可用环境变量 BRIDGE_PORT 修改）：
  GET    /health              -> {"ok": true}
  GET    /info                -> {"provider": "...", "model": "..."}
  POST   /chat                -> 创建任务，立即返回 {"task_id": "...", "status": "running"}
                                请求体 {"session_id": "...", "message": "...", "task_id": "可选"}
  GET    /task/<id>/stream    -> SSE 流（先重放已有事件，再实时增量）
  GET    /task/<id>/state     -> {"task_id", "status", "content", "tools", "event_count"}
  POST   /cancel              -> 显式取消任务 {"task_id"} 或 {"session_id"}
  DELETE /session/<id>        -> 清空会话上下文（并取消其正在生成的任务）

事件格式：
  data: {"content": "..."}      文本增量
  data: {"tool": {...}}         工具调用事件
  data: {"status": "working", "silent_seconds": N}
                                模型长时间无输出（如 Ollama 超时后 agent 内部重试）的保活提示
  data: {"done": true, "usage": {}}
  data: {"cancelled": true}     客户端显式停止
  data: {"error": "..."}        错误（含 agent 重试耗尽后透传的错误文案）

关键设计（任务化 + 断点续传）：
  - /chat 立即返回，AgentLoop 在后台独立线程的事件循环里跑，不绑定前端连接。
  - 客户端断开 SSE 连接「不会」取消任务，模型继续跑，结果累积到任务 buffer。
  - 只有显式调用 /cancel 才真正关闭 provider 连接、取消协程（断 Ollama，模型停算）。
  - 断线重连：重新订阅 /task/<id>/stream，先 catch-up 已生成事件，再收实时增量。
"""
import asyncio
import json
import os
import queue
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent_mini.config import load_config, save_config, MEMORY_FILE
from agent_mini.providers import create_provider
from agent_mini.agent import AgentLoop, Memory

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8765"))

# session_id -> {"conversation", "lock", "worker"}
_sessions = {}
_sessions_guard = threading.Lock()

# task_id -> task dict
_tasks = {}
_tasks_guard = threading.Lock()


def _get_session(session_id):
    with _sessions_guard:
        if session_id not in _sessions:
            _sessions[session_id] = {
                "conversation": [],
                "lock": threading.Lock(),
                "worker": None,
            }
        return _sessions[session_id]


def _basic_info():
    config = load_config()
    prov = config.get("provider", "ollama")
    model = config.get("providers", {}).get(prov, {}).get("model", "?")
    return {"provider": prov, "model": model}


def _ensure_utf8_memory_file():
    """自愈：确保 memory.json 是 UTF-8 可读的。

    agent_mini 的 Memory._load() 用 UTF-8 读该文件；若被 Windows 工具
    写成 GBK 等非 UTF-8 编码，agent 会在启动阶段直接抛 UnicodeDecodeError，
    表现为任务瞬间失败且无任何事件。这里在启动时检测并转换为 UTF-8。
    """
    import pathlib
    p = pathlib.Path(MEMORY_FILE)
    if not p.exists():
        return
    try:
        p.read_text(encoding="utf-8")
        return  # 已可读，无需处理
    except UnicodeDecodeError:
        pass
    try:
        text = p.read_bytes().decode("gb18030")  # GBK 超集，兼容性最好
        backup = p.with_suffix(".json.gbk.bak")
        if not backup.exists():
            p.rename(backup)
        p.write_text(text, encoding="utf-8")
        print(f"memory 文件编码异常已修复为 UTF-8: {MEMORY_FILE}")
    except Exception as e:  # noqa: BLE001
        print(f"memory 文件编码修复失败（不影响启动）: {e}")


def _new_task(session_id, task_id=None):
    """创建任务；若前端传入的 task_id 已存在则退回自动生成，避免覆盖。"""
    if task_id:
        with _tasks_guard:
            if task_id in _tasks:
                task_id = None
    task_id = task_id or uuid.uuid4().hex
    task = {
        "id": task_id,
        "session_id": session_id,
        "status": "running",
        "events": [],
        "subscribers": [],
        "lock": threading.Lock(),
        "cancel_ev": threading.Event(),
        "loop": None,
        "asyncio_task": None,
        "provider": None,
        "worker": None,
    }
    with _tasks_guard:
        _tasks[task_id] = task
    return task


def _emit(task, event):
    """写入任务 buffer 并广播给所有订阅者。"""
    with task["lock"]:
        task["events"].append(event)
        subs = list(task["subscribers"])
    for q in subs:
        q.put(event)


def _finish(task, status):
    """任务结束：更新状态并广播结束哨兵（None）。"""
    with task["lock"]:
        task["status"] = status
        subs = list(task["subscribers"])
    for q in subs:
        q.put(None)


def _request_cancel_task(task):
    """真正停止正在生成的 agent：
    1) 立即关闭 provider 的 httpx client -> 断开与 Ollama 的连接，模型停止计算；
    2) asyncio task.cancel() 让协程正常展开清理；
    3) 8s 兜底强制停 loop，保证 worker 线程必然退出。
    """
    cancel_ev = task.get("cancel_ev")
    if cancel_ev is not None:
        cancel_ev.set()
    lp = task.get("loop")
    if lp is None or lp.is_closed():
        return

    def _do():
        prov = task.get("provider")
        if prov is not None:
            try:
                asyncio.ensure_future(prov.close())
            except Exception:
                pass
        t = task.get("asyncio_task")
        if t is not None and not t.done():
            t.cancel()
        try:
            lp.call_later(8, lp.stop)
        except Exception:
            pass

    try:
        lp.call_soon_threadsafe(_do)
    except Exception:
        pass


def _task_worker_thread(task, session, message):
    """在独立线程 + 独立事件循环里跑 AgentLoop，事件写入任务 buffer 并广播。"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    task["loop"] = loop

    async def run():
        config = load_config()
        provider = create_provider(config)
        task["provider"] = provider
        memory = Memory(MEMORY_FILE, max_entries=config.get("memory", {}).get("maxEntries", 1000))
        agent = AgentLoop(provider, config, memory)
        conversation = session["conversation"]
        cancel_ev = task["cancel_ev"]

        # 记录最近一次有实际内容输出的时刻，用于探测「长时间静默」
        # （Ollama 超时后 agent 内部会重试，期间没有任何流式输出）。
        last_activity = {"t": time.monotonic()}

        async def on_stream(delta):
            if cancel_ev.is_set():
                raise asyncio.CancelledError("stopped")
            last_activity["t"] = time.monotonic()
            _emit(task, {"content": delta})

        async def on_tool_event(ev):
            if cancel_ev.is_set():
                raise asyncio.CancelledError("stopped")
            last_activity["t"] = time.monotonic()
            _emit(task, {
                "tool": {
                    "name": ev.name,
                    "arguments": ev.arguments or {},
                    "result_preview": ev.result_preview or "",
                    "is_error": ev.is_error,
                    "duration": ev.duration,
                }
            })

        async def _slow_notifier():
            """模型长时间无输出（如 Ollama 超时后的重试等待）时发状态事件。

            两个作用：
              1) 前端能显示「模型响应较慢，请稍候」，而不是长时间空白/误判断开；
              2) SSE 持续有数据，配合心跳注释避免中间代理空闲断连。
            """
            while True:
                await asyncio.sleep(10)
                if cancel_ev.is_set():
                    return
                silent = int(time.monotonic() - last_activity["t"])
                if silent >= 10:
                    _emit(task, {"status": "working", "silent_seconds": silent})

        notifier = asyncio.create_task(_slow_notifier())
        try:
            result = await agent.run(message, conversation, on_stream=on_stream, on_tool_event=on_tool_event)
            # agent.run() 在 provider 重试耗尽时不抛异常，而是返回错误字符串；
            # 这里必须透传给前端，否则会被当成一次「假完成」（done）静默吞掉。
            if isinstance(result, str) and (
                result.startswith("Error") or result.startswith("Reached maximum")
            ):
                _emit(task, {"error": result})
                return "error"
            _emit(task, {"done": True, "usage": agent.turn_usage})
            return "done"
        except asyncio.CancelledError:
            _emit(task, {"cancelled": True})
            return "cancelled"
        except Exception as e:  # noqa: BLE001
            if cancel_ev.is_set():
                _emit(task, {"cancelled": True})
                return "cancelled"
            _emit(task, {"error": f"{type(e).__name__}: {e}"})
            return "error"
        finally:
            notifier.cancel()
            try:
                await agent.close()
            except Exception:
                pass

    try:
        status = loop.run_until_complete(run())
    except Exception:
        status = "error"
    finally:
        try:
            loop.close()
        except Exception:
            pass
        _finish(task, status)
        session["worker"] = None
        session["lock"].release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_sse(self, item):
        line = "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"
        self.wfile.write(line.encode("utf-8"))
        self.wfile.flush()

    def _write_sse_comment(self):
        """SSE 注释行（以 ':' 开头），客户端/代理会忽略，仅用于保活。

        Ollama 生成超时后 agent 内部会重试（最长可静默十几分钟），
        若无任何数据输出，中间的代理（公网隧道等）会因空闲超时掐断连接，
        前端随即报「断开连接」。每 15s 发一条注释即可保持连接活跃。
        """
        self.wfile.write(b": ping\n\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        if self.path == "/info":
            try:
                return self._json(200, _basic_info())
            except Exception as e:
                return self._json(500, {"error": str(e)})
        if self.path == "/models":
            try:
                config = load_config()
                active = config.get("provider", "ollama")
                providers = config.get("providers", {})
                models = []
                for name, cfg in providers.items():
                    models.append({
                        "provider": name,
                        "model": (cfg or {}).get("model", ""),
                        "active": name == active,
                    })
                return self._json(200, {"active": active, "models": models})
            except Exception as e:
                return self._json(500, {"error": str(e)})

        m = re.match(r"^/task/([^/]+)/stream$", self.path)
        if m:
            return self._stream_task(m.group(1))
        m = re.match(r"^/task/([^/]+)/state$", self.path)
        if m:
            return self._task_state(m.group(1))
        self._json(404, {"error": "not found"})

    def _stream_task(self, task_id):
        with _tasks_guard:
            task = _tasks.get(task_id)
        if task is None:
            return self._json(404, {"error": "task not found"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        q = queue.Queue()
        # 锁内原子完成「读已有事件 + 注册订阅者」，避免重放与实时之间漏事件
        with task["lock"]:
            events = list(task["events"])
            status = task["status"]
            task["subscribers"].append(q)
        try:
            for ev in events:
                self._write_sse(ev)
            if status != "running":
                return
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    if task["status"] != "running":
                        break
                    # 无事件期间发心跳注释保活（间隔 15s）
                    self._write_sse_comment()
                    continue
                if item is None:
                    break
                self._write_sse(item)
        except (BrokenPipeError, ConnectionResetError, OSError):
            # 订阅者断开：不影响任务，仅清理订阅
            pass
        finally:
            with task["lock"]:
                if q in task["subscribers"]:
                    task["subscribers"].remove(q)

    def _task_state(self, task_id):
        with _tasks_guard:
            task = _tasks.get(task_id)
        if task is None:
            return self._json(404, {"error": "task not found"})
        with task["lock"]:
            events = list(task["events"])
            status = task["status"]
        content = "".join(e.get("content", "") for e in events if "content" in e)
        tools = [e["tool"] for e in events if "tool" in e]
        return self._json(200, {
            "task_id": task_id,
            "status": status,
            "content": content,
            "tools": tools,
            "event_count": len(events),
        })

    def do_DELETE(self):
        if self.path.startswith("/session/"):
            sid = self.path[len("/session/"):]
            with _sessions_guard:
                sess = _sessions.pop(sid, None)
            if sess is not None:
                with _tasks_guard:
                    tasks = [t for t in _tasks.values() if t.get("session_id") == sid]
                    for t in tasks:
                        _tasks.pop(t["id"], None)
                for t in tasks:
                    _request_cancel_task(t)
                w = sess.get("worker")
                if w is not None and w.is_alive():
                    w.join(timeout=6)
            return self._json(200, {"ok": True, "deleted": bool(sess)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/config":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self._json(400, {"error": "invalid JSON body"})
            try:
                config = load_config()
                providers = config.get("providers", {})
                provider = (payload.get("provider") or "").strip()
                if not provider or provider not in providers:
                    return self._json(400, {"error": f"未知的 provider: {provider}"})
                model = (payload.get("model") or "").strip()
                if model:
                    providers[provider]["model"] = model
                config["provider"] = provider
                save_config(config)
                new_model = providers[provider].get("model", "?")
                print(f"[Config] 模型已切换 -> {provider} / {new_model}")
                return self._json(200, {"ok": True, "provider": provider, "model": new_model})
            except Exception as e:
                return self._json(500, {"error": f"切换失败: {e}"})

        if self.path == "/cancel":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self._json(400, {"error": "invalid JSON body"})
            task_id = (payload.get("task_id") or "").strip()
            session_id = (payload.get("session_id") or "").strip()
            if task_id:
                with _tasks_guard:
                    task = _tasks.get(task_id)
                if task is not None:
                    _request_cancel_task(task)
                return self._json(200, {"ok": True})
            if session_id:
                with _tasks_guard:
                    tasks = [t for t in _tasks.values() if t.get("session_id") == session_id]
                for t in tasks:
                    _request_cancel_task(t)
                return self._json(200, {"ok": True})
            return self._json(400, {"error": "task_id or session_id required"})

        if self.path != "/chat":
            return self._json(404, {"error": "not found"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON body"})

        message = (payload.get("message") or "").strip()
        session_id = (payload.get("session_id") or "default").strip()
        task_id = (payload.get("task_id") or "").strip() or None
        if not message:
            return self._json(400, {"error": "message is required"})

        session = _get_session(session_id)

        # 会话串行：同一会话同时只允许一个任务在跑
        if not session["lock"].acquire(blocking=False):
            return self._json(409, {"error": "该会话正在生成回复，请稍候"})

        try:
            task = _new_task(session_id, task_id)
            t = threading.Thread(target=_task_worker_thread, args=(task, session, message), daemon=True)
            task["worker"] = t
            session["worker"] = t
            t.start()
        except Exception:
            session["lock"].release()
            raise

        return self._json(200, {"task_id": task["id"], "status": "running"})


def main():
    _ensure_utf8_memory_file()
    info = _basic_info()
    server = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)
    print(f"agent-mini bridge 已启动: http://127.0.0.1:{BRIDGE_PORT}")
    print(f"provider: {info['provider']} | model: {info['model']}")
    server.serve_forever()


if __name__ == "__main__":
    main()
