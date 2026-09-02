/**
 * agent-mini WebUI 后端（任务化 + 断点续传版）
 * 零依赖 Node HTTP 服务器，代理到本地 agent-mini 桥接服务（agent_bridge.py）：
 *  - POST /api/chat                   创建任务，立即返回 {taskId}（模型后台异步跑）
 *  - GET  /api/chat/:id/stream        SSE 订阅（先 catch-up 已生成内容，再实时增量）
 *  - GET  /api/chat/:id/state         查询任务状态 / 已生成内容
 *  - POST /api/chat/:id/stop          显式停止
 *  - GET  /api/session/:id/history    读取落盘会话历史
 *  - DELETE /api/session/:id          清空会话
 *  - GET  /api/config                 返回 provider / model
 *  - GET  /api/health                 健康检查
 *  - 静态文件托管 ./public
 *
 * 关键设计：
 *  - 前端断开 SSE「不会」取消模型；模型在桥接服务后台继续跑，结果落盘。
 *  - 服务端为每个任务维护事件 buffer，前端重连时 catch-up，不丢不漏。
 *  - 任务完成（done/cancelled）后把 user/assistant 落盘到 logs/sessions/<id>.json。
 *
 * 环境变量：
 *  AGENT_BRIDGE  桥接服务地址，默认 http://127.0.0.1:8765
 *  PORT          默认 3000
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const BRIDGE = (process.env.AGENT_BRIDGE || "http://127.0.0.1:8765").replace(/\/+$/, "");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_DIR = path.join(__dirname, "logs", "sessions");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// taskId -> task（内存态；落盘见 logs/sessions）
const tasks = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function bridgeOk() {
  try {
    const r = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(task, data) {
  const line = sseLine(data);
  for (const res of task.subscribers) {
    try {
      res.write(line);
    } catch {
      /* 订阅者已断开，忽略 */
    }
  }
}

function persistTask(task) {
  const content = task.events.filter((e) => "content" in e).map((e) => e.content).join("");
  const tools = task.events.filter((e) => "tool" in e).map((e) => e.tool);
  const file = path.join(SESSION_DIR, `${task.sessionId}.json`);
  let data = { sessionId: task.sessionId, messages: [] };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* 首次写入 */
  }
  data.messages.push({ role: "user", content: task.message, time: task.time });
  data.messages.push({
    role: "assistant",
    content,
    tools: tools.length ? tools : undefined,
    time: Date.now(),
    taskId: task.id,
  });
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("落盘失败:", err.message);
  }
}

// node -> bridge 持久订阅：累积 buffer、广播给前端、完成时落盘
// 断线自动重连（bridge 支持断线重订阅：先 catch-up 已有事件再收增量，
// 不会重复触发模型），只有重连多次仍失败或任务已结束才停止。
async function bridgeSubscribe(task) {
  let attempts = 0;
  while (true) {
    let upstream;
    try {
      upstream = await fetch(`${BRIDGE}/task/${task.id}/stream`);
    } catch {
      attempts++;
      if (attempts >= 5 || task.status !== "running") {
        failTask(task, "无法连接桥接服务");
        return;
      }
      await sleep(Math.min(1000 * attempts, 5000));
      continue;
    }
    if (!upstream.ok) {
      // 404 等：bridge 重启后任务已丢失，无法恢复
      failTask(task, `桥接服务返回 ${upstream.status}`);
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let broken = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          let data;
          try {
            data = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          task.events.push(data);
          if (data.done) task.status = "done";
          else if (data.cancelled) task.status = "cancelled";
          else if (data.error) task.status = "error";
          broadcast(task, data);
          if ((data.done || data.cancelled) && !task.persisted) {
            task.persisted = true;
            persistTask(task);
          }
        }
      }
      return; // 正常 EOF（任务已结束）
    } catch {
      broken = true;
    }

    // 流中断：任务还在跑则退避重连；任务已结束则无需处理
    if (!broken || task.status !== "running") return;
    attempts++;
    if (attempts >= 5) {
      failTask(task, "桥接连接中断");
      return;
    }
    console.warn(`[bridge] 任务 ${task.id} 连接中断，${attempts}/5 自动重连...`);
    await sleep(Math.min(1000 * attempts, 5000));
  }
}

function failTask(task, message) {
  if (task.status !== "running") return;
  task.status = "error";
  const ev = { error: message };
  task.events.push(ev);
  broadcast(task, ev);
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }

  const message = (payload.message || "").trim();
  if (!message) return sendJson(res, 400, { error: "message is required" });
  const sessionId = (payload.sessionId || "default").trim();
  const taskId = crypto.randomUUID();

  let upstream;
  try {
    upstream = await fetch(`${BRIDGE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message, task_id: taskId }),
    });
  } catch (err) {
    return sendJson(res, 502, {
      error: "无法连接 agent-mini 桥接服务。请先运行 agent_bridge.py。",
      detail: err.message,
    });
  }
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    return sendJson(res, upstream.status, err);
  }

  const task = {
    id: taskId,
    sessionId,
    message,
    time: Date.now(),
    status: "running",
    events: [],
    subscribers: [],
    persisted: false,
  };
  tasks.set(taskId, task);

  // 后台订阅桥接服务（不阻塞响应），前端断开也不影响
  bridgeSubscribe(task).catch(() => { });

  return sendJson(res, 200, { taskId, status: "running" });
}

function handleStream(req, res, taskId) {
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });

  // 增量续传：只回放 since 之后的事件，避免重连时把已收到的内容再发一遍（重复）
  let since = 0;
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    since = parseInt(u.searchParams.get("since") || "0", 10) || 0;
  } catch { }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // catch-up：从断点之后增量重放（前端已收到的不再发）
  for (let i = since; i < task.events.length; i++) {
    res.write(sseLine(task.events[i]));
  }
  if (task.status !== "running") {
    res.end();
    return;
  }

  task.subscribers.push(res);
  // 浏览器端 SSE 心跳：公网隧道等代理会因空闲超时掐断连接，
  // 每 15s 发一条注释行（客户端忽略）即可保活。
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* 已断开 */
    }
  }, 15000);
  res.on("close", () => {
    clearInterval(hb);
    task.subscribers = task.subscribers.filter((r) => r !== res);
  });
}

function handleState(res, taskId) {
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, { error: "任务不存在或已过期" });
  const content = task.events.filter((e) => "content" in e).map((e) => e.content).join("");
  const tools = task.events.filter((e) => "tool" in e).map((e) => e.tool);
  return sendJson(res, 200, {
    taskId,
    status: task.status,
    content,
    tools,
    event_count: task.events.length,
  });
}

async function handleStop(res, taskId) {
  try {
    await fetch(`${BRIDGE}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
    });
    const task = tasks.get(taskId);
    if (task) task.status = "cancelled";
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 502, { error: `桥接服务不可用：${err.message}` });
  }
}

function handleHistory(res, id) {
  const file = path.join(SESSION_DIR, `${id}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return sendJson(res, 200, data);
  } catch {
    return sendJson(res, 200, { sessionId: id, messages: [] });
  }
}

async function handleDeleteSession(res, id) {
  try {
    const r = await fetch(`${BRIDGE}/session/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    try {
      fs.unlinkSync(path.join(SESSION_DIR, `${id}.json`));
    } catch {
      /* 无落盘文件 */
    }
    sendJson(res, r.status, data);
  } catch (err) {
    sendJson(res, 502, { error: `桥接服务不可用：${err.message}` });
  }
}

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not Found");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- CORS（关键：支持 Capacitor App 跨域访问） ----------
// 浏览器端同源访问，无需 CORS；但 App 的 WebView 页面源自本地 capacitor://localhost，
// 向公网 wicp 地址发起 fetch 属「跨域」，必须由服务端返回 CORS 头，否则浏览器直接拦截
// （表现就是设置里点“保存并测试”报“无法连接”，即便服务器明明在线）。
// 另外 POST(application/json) 与 DELETE 会触发浏览器 OPTIONS 预检，也必须回应。
function applyCors(req, res) {
  const origin = req.headers.origin;
  // 反射请求来源（非凭据请求下等同于放行该来源）；无 origin 时退化为 *
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  // 预检请求：直接返回 204 + CORS 头，否则跨域 POST/DELETE 会被浏览器拦截
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === "/api/health") {
    return sendJson(res, 200, { ok: true, bridge: await bridgeOk() });
  }
  if (p === "/api/monitor" && req.method === "GET") {
    // 本机实时监控（电量/CPU/内存）：读 monitor_tool.py 周期写入的 monitor.json
    const mp = path.join(__dirname, "monitor.json");
    try {
      const raw = fs.readFileSync(mp, "utf8");
      return sendJson(res, 200, { ...JSON.parse(raw), available: true });
    } catch {
      return sendJson(res, 200, { available: false, error: "monitor.json 未生成（monitor_tool 未运行）" });
    }
  }
  if (p === "/api/stop-all" && req.method === "POST") {
    // 停止所有 agent 任务（前端“停止所有任务”按钮）
    try {
      const r = await fetch(`${BRIDGE}/stop-all`, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      return sendJson(res, 200, { ...data, bridge: true });
    } catch {
      return sendJson(res, 200, { ok: false, error: "桥接服务不可达", bridge: false });
    }
  }
  if (p === "/api/config" && req.method === "GET") {
    try {
      const r = await fetch(`${BRIDGE}/info`, { signal: AbortSignal.timeout(2000) });
      const info = await r.json();
      return sendJson(res, 200, { ...info, bridge: true });
    } catch {
      return sendJson(res, 200, { provider: "agent-mini", model: "桥接服务未启动", bridge: false });
    }
  }
  if (p === "/api/models" && req.method === "GET") {
    try {
      const r = await fetch(`${BRIDGE}/models`, { signal: AbortSignal.timeout(3000) });
      const data = await r.json();
      return sendJson(res, 200, { ...data, bridge: true });
    } catch {
      return sendJson(res, 200, { active: "", models: [], bridge: false });
    }
  }
  if (p === "/api/config" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    try {
      const r = await fetch(`${BRIDGE}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
      const data = await r.json();
      return sendJson(res, r.status, data);
    } catch (err) {
      return sendJson(res, 502, { error: `桥接服务不可用：${err.message}` });
    }
  }
  if (p === "/api/chat" && req.method === "POST") return handleChat(req, res);

  let m = p.match(/^\/api\/chat\/([^/]+)\/stream$/);
  if (m && req.method === "GET") return handleStream(req, res, m[1]);
  m = p.match(/^\/api\/chat\/([^/]+)\/state$/);
  if (m && req.method === "GET") return handleState(res, m[1]);
  m = p.match(/^\/api\/chat\/([^/]+)\/stop$/);
  if (m && req.method === "POST") return handleStop(res, m[1]);
  m = p.match(/^\/api\/session\/([^/]+)\/history$/);
  if (m && req.method === "GET") return handleHistory(res, m[1]);
  m = p.match(/^\/api\/session\/([^/]+)$/);
  if (m && req.method === "DELETE") return handleDeleteSession(res, m[1]);
  if (req.method === "GET") return serveStatic(req, res, decodeURIComponent(p));

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, async () => {
  console.log(`agent-mini WebUI 已启动: http://localhost:${PORT}`);
  console.log(`桥接服务: ${BRIDGE} (${(await bridgeOk()) ? "已连接" : "未连接，请先启动 agent_bridge.py"})`);
});
