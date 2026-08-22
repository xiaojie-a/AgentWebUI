/* AgentWebUI 前端逻辑（对接本地 agent-mini 桥接服务） */
(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const sidebar = $("sidebar"), sidebarOverlay = $("sidebarOverlay"), convList = $("convList"), messagesEl = $("messages"),
    welcomeEl = $("welcome"), chatScroll = $("chatScroll"), input = $("input"),
    sendBtn = $("sendBtn"), topbarTitle = $("topbarTitle"), modelBadge = $("modelBadge"),
    settingsModal = $("settingsModal");

  // ---------- 状态 ----------
  let conversations = loadConvs();
  let currentId = localStorage.getItem("am_current") || null;
  if (currentId && !conversations.find((c) => c.id === currentId)) currentId = null;
  let streaming = false;
  let abortCtrl = null;

  // ---------- 工具 ----------
  function loadConvs() {
    try { return JSON.parse(localStorage.getItem("am_convs") || "[]"); }
    catch { return []; }
  }
  function saveConvs() { localStorage.setItem("am_convs", JSON.stringify(conversations)); }
  function saveCurrentId() { localStorage.setItem("am_current", currentId || ""); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function currentConv() { return conversations.find((c) => c.id === currentId) || null; }

  // ---------- 轻量 Markdown 渲染 ----------
  function md(src) {
    const codeBlocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang, code: code.replace(/\n$/, "") });
      return ` CODE${codeBlocks.length - 1} `;
    });
    let html = esc(src);
    html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>")
               .replace(/^## (.*)$/gm, "<h2>$1</h2>")
               .replace(/^# (.*)$/gm, "<h1>$1</h1>");
    html = html.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
               .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
               .replace(/`([^`]+)`/g, "<code>$1</code>")
               .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
      const rows = block.trim().split("\n").filter((r) => !/^\|[\s\-:|]+\|$/.test(r));
      if (!rows.length) return block;
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let t = "<table>";
      rows.forEach((r, i) => {
        const tag = i === 0 ? "th" : "td";
        t += "<tr>" + cells(r).map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
      });
      return t + "</table>";
    });
    html = html.replace(/((?:^[-*] .+$\n?)+)/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
      return `<ul>${items}</ul>`;
    });
    html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
      return `<ol>${items}</ol>`;
    });
    html = html.split(/\n{2,}/).map((p) => {
      p = p.trim();
      if (!p) return "";
      if (/^<(h\d|ul|ol|table|blockquote|pre)/.test(p)) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    }).join("");
    html = html.replace(/ CODE(\d+) /g, (_, i) => {
      const { lang, code } = codeBlocks[+i];
      return `<pre><div class="code-header"><span>${lang || "code"}</span><button class="copy-btn" data-code="${esc(code)}">复制</button></div><code>${esc(code)}</code></pre>`;
    });
    return html;
  }

  // 从工具参数中提取底层命令/动作字符串
  function extractCommand(t) {
    const a = t.arguments || {};
    if (typeof a === "string") return a;
    if (typeof a === "object" && a) {
      if (a.cmd) return String(a.cmd);
      if (a.command) return String(a.command);
      if (a.action) {
        const parts = ["action=" + a.action];
        for (const k of ["x", "y", "x2", "y2", "text", "value", "title", "package", "keep", "keycode", "duration"]) {
          if (a[k] !== undefined && a[k] !== "") parts.push(k + "=" + a[k]);
        }
        return parts.join(" ");
      }
    }
    return "";
  }

  // 方案 A：基于 工具名 + 底层命令 自动生成中文说明（描述动作，非模型真实意图）
  function describeReason(t) {
    const cmd = extractCommand(t).toLowerCase();
    const rules = [
      [/screencap/, "执行手机截图（保存 PNG）"],
      [/input\s+tap/, "模拟点击屏幕指定坐标"],
      [/input\s+swipe/, "模拟滑动屏幕"],
      [/input\s+keyevent\s+(\d+)/, (m) => {
        const map = { 3: "返回桌面(Home)", 4: "返回上一级", 26: "电源键", 224: "点亮屏幕", 223: "熄灭屏幕", 164: "静音" };
        return "发送按键：" + (map[m[1]] || ("按键码 " + m[1]));
      }],
      [/input\s+text/, "在输入框中输入文字"],
      [/cmd\s+wifi/, "切换 WiFi 开关"],
      [/bluetooth/, "切换蓝牙开关"],
      [/vibrator/, "触发手机震动反馈"],
      [/media_session\s+volume/, "调节媒体音量"],
      [/notification\s+post/, "发送系统通知"],
      [/dumpsys\s+location/, "获取当前定位信息"],
      [/pm\s+list\s+packages/, "列出已安装应用"],
      [/am\s+force-stop/, "强制停止指定应用"],
      [/monkey\s+/, "启动指定应用"],
      [/svc\s+power\s+stayon/, "设置屏幕保持常亮"],
      [/leds\//, "控制 RGB 呼吸灯"],
    ];
    for (const [re, desc] of rules) {
      const m = cmd.match(re);
      if (m) return typeof desc === "function" ? desc(m) : desc;
    }
    // 语义化工具（如 phone_control）按 action 兜底
    const a = t.arguments || {};
    if (t.name === "phone_control" && a.action) return "调用手机控制工具：" + a.action;
    if (t.name === "shell_exec") return "调用 shell 执行底层命令";
    return "调用 " + (t.name || "工具") + " 执行操作";
  }

  // 工具调用事件 -> 可折叠标签：默认折叠为灰色摘要行（action=xx 参数=yy ›），点击箭头展开命令/原因/结果
  function toolChip(t) {
    const preview = (t.result_preview || "").replace(/\s+/g, " ").slice(0, 80);
    const cmd = extractCommand(t);
    const reason = describeReason(t);
    // 摘要：action=xxx 其他 key=value
    const args = t.arguments || {};
    const parts = [];
    if (args.action) parts.push(`action=${args.action}`);
    for (const [k, v] of Object.entries(args)) {
      if (k === "action" || v === undefined || v === null || v === "") continue;
      const s = String(v);
      parts.push(`${k}=${s.length > 28 ? s.slice(0, 28) + "…" : s}`);
    }
    const summary = parts.join(" ") || preview || "(无参数)";
    const detail = [
      cmd ? `<div class="tool-line"><span class="tool-lbl">命令</span><code class="tool-cmd">${esc(cmd).slice(0, 160)}</code></div>` : "",
      reason ? `<div class="tool-line"><span class="tool-lbl">原因</span><span class="tool-reason">${esc(reason)}</span></div>` : "",
      preview ? `<div class="tool-line"><span class="tool-lbl">结果</span><span class="tool-result">${esc(preview)}</span></div>` : "",
    ].join("");
    return `<div class="tool-chip${t.is_error ? " error" : ""}" title="${esc(JSON.stringify(args))}">
      <button type="button" class="tool-head">
        <span class="tool-icon">${t.is_error ? "⚠️" : "🔧"}</span>
        <span class="tool-name">${esc(t.name)}</span>
        <code class="tool-summary">${esc(summary)}</code>
        ${t.duration ? `<span class="tool-time">${t.duration.toFixed(1)}s</span>` : ""}
        <span class="tool-toggle">›</span>
      </button>
      <div class="tool-detail">${detail || `<div class="tool-line"><span class="tool-lbl">结果</span><span class="tool-result">（无输出）</span></div>`}</div>
    </div>`;
  }

  // ---------- 渲染 ----------
  function renderConvList() {
    convList.innerHTML = "";
    if (!conversations.length) {
      convList.innerHTML = `<div class="conv-empty">还没有对话，点上方开始吧</div>`;
      return;
    }
    for (const c of conversations) {
      const btn = document.createElement("button");
      btn.className = "conv-item" + (c.id === currentId ? " active" : "");
      btn.innerHTML = `<span class="conv-title">${esc(c.title)}</span>
        <span class="conv-del" title="删除">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
        </span>`;
      btn.onclick = () => { switchConv(c.id); if (isMobile()) closeSidebar(); };
      btn.querySelector(".conv-del").onclick = (e) => {
        e.stopPropagation();
        conversations = conversations.filter((x) => x.id !== c.id);
        if (currentId === c.id) { currentId = null; renderMessages(); }
        saveConvs(); renderConvList();
        // 同步清理 agent-mini 端的会话上下文
        fetch(`/api/session/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => {});
      };
      convList.appendChild(btn);
    }
  }

  function msgNode(role, text, tools) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const avatar = role === "user" ? "🙂" : "✦";
    let content;
    if (role === "user") {
      content = esc(text);
    } else {
      const toolsHtml = tools && tools.length
        ? `<div class="tool-list">${tools.map(toolChip).join("")}</div>` : "";
      content = toolsHtml + md(text);
    }
    div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-bubble">${content}</div>`;
    return div;
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    const conv = currentConv();
    welcomeEl.style.display = conv && conv.messages.length ? "none" : "";
    topbarTitle.textContent = conv ? conv.title : "新对话";
    if (!conv) return;
    for (const m of conv.messages) {
      messagesEl.appendChild(msgNode(m.role, m.content, m.tools));
    }
    scrollBottom();
  }

  function scrollBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }

  function switchConv(id) { currentId = id; saveCurrentId(); renderConvList(); renderMessages(); }

  function newConv() {
    if (isMobile()) closeSidebar(); // 手机端点击「新对话」自动收起侧边栏
    currentId = null;
    saveCurrentId();
    renderConvList(); renderMessages();
    input.focus();
  }

  // 侧边栏开合（移动端带遮罩：点击遮罩/滑动关闭，背后内容压暗且禁止交互）
  function isMobile() { return innerWidth <= 768; }
  function openSidebar() {
    sidebar.classList.remove("collapsed");
    if (isMobile()) sidebarOverlay.classList.add("show");
  }
  function closeSidebar() {
    sidebar.classList.add("collapsed");
    if (isMobile()) sidebarOverlay.classList.remove("show");
  }

  // ---------- 后端地址（浏览器端与页面同源，直接用相对路径） ----------
  function api(p) { return p; }

  // ---------- 错误 & 工具 ----------
  function isNetworkError(err) {
    if (!err) return false;
    const m = String(err.message || err).toLowerCase();
    return /network error|failed to fetch|fetch failed|load failed|connection|econnreset|econnrefused|socket|net::err|aborted/i.test(m);
  }
  function friendlyError(err) {
    if (isNetworkError(err)) return "网络连接中断";
    return (err && err.message) ? err.message : "请求失败";
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 进行中任务的持久化记录（页面重开 / 切后台后据此恢复）
  function setActiveTask(taskId, convId) {
    localStorage.setItem("am_active_task", JSON.stringify({ taskId, convId }));
  }
  function clearActiveTask() { localStorage.removeItem("am_active_task"); }
  function getActiveTask() {
    try { return JSON.parse(localStorage.getItem("am_active_task") || "null"); } catch { return null; }
  }
  async function stopTask(taskId) {
    try { await fetch(api(`/api/chat/${taskId}/stop`), { method: "POST" }); } catch {}
  }

  // 断线后查任务状态：决定「重连订阅」还是「用状态补齐结束」
  async function recoverTask(taskId, ctx) {
    try {
      const st = await fetch(api(`/api/chat/${taskId}/state`)).then((r) => r.json());
      if (st.status === "running") {
        ctx.eventIndex = st.event_count || ctx.eventIndex;
        await sleep(1000);
        return "continue";
      }
      if (st.status === "done" || st.status === "cancelled") {
        ctx.full = st.content || ctx.full;
        ctx.tools = st.tools || ctx.tools;
        if (ctx.rebuild) ctx.rebuild();
        if (st.status === "done") ctx.normalDone = true;
        return "done";
      }
      return "fail";
    } catch { return "fail"; }
  }

  // 订阅任务事件流：断线自动重连（重连是重新订阅 stream，不会重复触发模型）
  async function streamLoop(taskId, ctx, repaint, abortCtrl) {
    while (true) {
      let reader;
      try {
        const resp = await fetch(api(`/api/chat/${taskId}/stream?since=${ctx.eventIndex}`), {
          signal: abortCtrl ? abortCtrl.signal : undefined,
        });
        if (!resp.ok) {
          const rec = await recoverTask(taskId, ctx);
          if (rec === "continue") continue;
          if (rec === "done") return;
          throw new Error("订阅失败 (" + resp.status + ")");
        }
        reader = resp.body.getReader();
      } catch (err) {
        if (err.name === "AbortError") throw err;
        const rec = await recoverTask(taskId, ctx);
        if (rec === "continue") continue;
        if (rec === "done") return;
        throw err;
      }
      const decoder = new TextDecoder();
      let buffer = "";
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
            try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
            ctx.eventIndex++;
            if (data.content) {
              ctx.statusTip = "";
              ctx.full += data.content;
              if (ctx.addText) ctx.addText(data.content);
              if (ctx.setCursor) ctx.setCursor(true);
              if (ctx.smartScroll) ctx.smartScroll(); else scrollBottom();
            }
            if (data.tool) {
              ctx.tools.push(data.tool);
              if (ctx.addTool) ctx.addTool(data.tool);
              if (ctx.setCursor) ctx.setCursor(true);
              if (ctx.smartScroll) ctx.smartScroll(); else scrollBottom();
            }
            // 模型长时间无输出（Ollama 超时后 agent 内部重试）时的保活提示
            if (data.status === "working" && !ctx.full && !ctx.tools.length) {
              ctx.statusTip = `⏳ 模型响应较慢，请稍候…（已等待 ${data.silent_seconds || 0} 秒）`;
              if (ctx.syncTip) ctx.syncTip();
            }
            if (data.done) { if (ctx.setCursor) ctx.setCursor(false); ctx.normalDone = true; return; }
            if (data.cancelled) { if (ctx.setCursor) ctx.setCursor(false); return; }
            if (data.error) { if (ctx.setCursor) ctx.setCursor(false); throw new Error(data.error); }
          }
        }
        return;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        const rec = await recoverTask(taskId, ctx);
        if (rec === "continue") continue;
        if (rec === "done") return;
        throw err;
      }
    }
  }

  // ---------- 发送 & 流式接收（任务化） ----------
  async function send(text) {
    text = text.trim();
    if (!text || streaming) return;

    let conv = currentConv();
    if (!conv) {
      conv = { id: uid(), title: text.slice(0, 20) || "新对话", messages: [], createdAt: Date.now() };
      conversations.unshift(conv);
      currentId = conv.id;
      saveCurrentId();
    }
    conv.messages.push({ role: "user", content: text });
    if (conv.messages.length === 1) conv.title = text.slice(0, 20);
    saveConvs(); renderConvList(); renderMessages();

    input.value = ""; autoGrow();
    setStreaming(true);

    const aiNode = msgNode("assistant", "");
    const bubble = aiNode.querySelector(".msg-bubble");
    bubble.innerHTML = `<span class="dots"><span></span><span></span><span></span></span>`;
    messagesEl.appendChild(aiNode);
    scrollBottom();

    abortCtrl = new AbortController();
    // 有序渲染节点：{type:"text", value} | {type:"tool", tool}
    // 流式过程增量更新（不重建 DOM、不重触发动画），工具卡片按到达顺序插入，不再固定堆在文本上方
    const ctx = { full: "", tools: [], nodes: [], nodeEls: [], statusTip: "", normalDone: false, eventIndex: 0 };
    bubble.innerHTML = `<div class="stream-body"><span class="dots"><span></span><span></span><span></span></span></div>`;
    const bodyEl = bubble.firstElementChild;
    const tipEl = document.createElement("div");
    tipEl.className = "waiting-tip";
    tipEl.style.display = "none";
    bodyEl.appendChild(tipEl);

    const renderNode = (n) => {
      if (n.type === "text") {
        const el = document.createElement("div");
        el.className = "stream-text";
        el.innerHTML = md(n.value);
        return el;
      }
      const el = document.createElement("div");
      el.className = "tool-list";
      el.innerHTML = toolChip(n.tool);
      return el;
    };

    const rebuildNodes = () => {
      // 从 full/tools 重建顺序（结束/恢复/错误兜底用；文本在前，工具按原顺序）
      ctx.nodes = [];
      ctx.nodeEls = [];
      bodyEl.innerHTML = "";
      if (ctx.full) ctx.nodes.push({ type: "text", value: ctx.full });
      for (const t of ctx.tools) ctx.nodes.push({ type: "tool", tool: t });
      for (const n of ctx.nodes) {
        const el = renderNode(n);
        bodyEl.appendChild(el);
        ctx.nodeEls.push(el);
      }
      bodyEl.appendChild(tipEl);
      syncTip();
    };

    const syncTip = () => {
      const show = !!ctx.statusTip && !ctx.nodes.length;
      tipEl.style.display = show ? "" : "none";
      tipEl.textContent = show ? ctx.statusTip : "";
    };

    ctx.addText = (delta) => {
      ctx.statusTip = "";
      bodyEl.querySelector(".dots")?.remove();
      const last = ctx.nodes[ctx.nodes.length - 1];
      if (last && last.type === "text") {
        last.value += delta;
        ctx.nodeEls[ctx.nodeEls.length - 1].innerHTML = md(last.value); // 仅重渲该文本节点
      } else {
        ctx.nodes.push({ type: "text", value: delta });
        const el = renderNode(ctx.nodes[ctx.nodes.length - 1]);
        bodyEl.insertBefore(el, tipEl);
        ctx.nodeEls.push(el);
      }
      syncTip();
    };

    ctx.addTool = (tool) => {
      ctx.statusTip = "";
      bodyEl.querySelector(".dots")?.remove();
      // bridge 对同一工具发两次事件：先带 arguments（无结果），后带 result_preview（无 arguments）→ 合并到同一节点
      const hasResult = tool.result_preview !== undefined && tool.result_preview !== null;
      const noArgs = !tool.arguments || !Object.keys(tool.arguments).length;
      if (hasResult && noArgs) {
        const last = ctx.nodes[ctx.nodes.length - 1];
        if (last && last.type === "tool") {
          last.tool = Object.assign({}, last.tool, tool); // 合并结果/耗时/错误态
          ctx.nodeEls[ctx.nodeEls.length - 1].innerHTML = toolChip(last.tool);
          return;
        }
      }
      ctx.nodes.push({ type: "tool", tool });
      const el = renderNode(ctx.nodes[ctx.nodes.length - 1]);
      bodyEl.insertBefore(el, tipEl);
      ctx.nodeEls.push(el);
      syncTip();
    };

    ctx.rebuild = rebuildNodes;
    ctx.syncTip = syncTip;
    ctx.setCursor = (on) => bubble.classList.toggle("typing-cursor", !!on);
    ctx.smartScroll = () => {
      const c = chatScroll;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 140) c.scrollTop = c.scrollHeight;
    };

    const repaint = (cursor) => {
      // 结束/恢复/错误时的重绘：保留流式过程的有序 nodes（工具与文本交错），不整体重建
      if (!ctx.nodes.length) {
        rebuildNodes(); // 无流式节点（如恢复场景）才用 full/tools 重建
      } else {
        const last = ctx.nodes[ctx.nodes.length - 1];
        if (last && last.type === "text") {
          last.value = ctx.full; // 同步完整文本（含结束/错误追加）
          ctx.nodeEls[ctx.nodeEls.length - 1].innerHTML = md(ctx.full);
        } else {
          ctx.addText(ctx.full || ""); // 最后节点是工具：补一个文本节点
        }
        syncTip();
      }
      ctx.setCursor(cursor);
      scrollBottom();
    };

    let taskId = null;
    try {
      // 1. 创建任务（立即返回，模型在服务端后台异步跑）
      const resp = await fetch(api("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: conv.id, message: text }),
        signal: abortCtrl.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `请求失败 (${resp.status})`);
      }
      const created = await resp.json();
      taskId = created.taskId;
      setActiveTask(taskId, conv.id);

      // 2. 订阅流（断线自动重连，不重复触发模型）
      await streamLoop(taskId, ctx, repaint, abortCtrl);
    } catch (err) {
      if (err.name === "AbortError") {
        if (taskId) stopTask(taskId);
        ctx.full += ctx.full ? "\n\n*(已停止生成)*" : "*(已停止生成)*";
      } else {
        ctx.full = ctx.full ? ctx.full + `\n\n⚠️ ${friendlyError(err)}` : `⚠️ ${friendlyError(err)}`;
      }
    } finally {
      repaint(false);
      if (ctx.full || ctx.tools.length) {
        conv.messages.push({ role: "assistant", content: ctx.full, tools: ctx.tools.length ? ctx.tools : undefined });
        saveConvs();
      }
      clearActiveTask();
      setStreaming(false);
      scrollBottom();
      if (ctx.normalDone && ctx.full) notifyReply(ctx.full);
    }
  }

  // 页面重开 / 重新可见后，恢复进行中的任务
  // 修复：恢复时自动选中并渲染该会话，避免“重开无输出 / 需手动刷新”
  async function recoverActiveTask() {
    if (streaming) return;
    const saved = getActiveTask();
    if (!saved || !saved.taskId) return;
    const conv = conversations.find((c) => c.id === saved.convId);
    if (!conv) { clearActiveTask(); return; }

    // 选中并展示该会话
    currentId = conv.id;
    renderConvList();
    renderMessages();

    let st;
    try {
      st = await fetch(api(`/api/chat/${saved.taskId}/state`)).then((r) => r.json());
    } catch { return; }

    if (st.status === "done" || st.status === "cancelled" || st.status === "error") {
      if (st.content) {
        const last = conv.messages[conv.messages.length - 1];
        if (!(last && last.role === "assistant" && last.content === st.content)) {
          conv.messages.push({ role: "assistant", content: st.content, tools: st.tools && st.tools.length ? st.tools : undefined });
          saveConvs();
        }
        renderMessages();
        if (st.status === "done") notifyReply(st.content);
      }
      clearActiveTask();
      return;
    }

    const ctx = { full: st.content || "", tools: st.tools || [], normalDone: false, eventIndex: st.event_count || 0 };
    let bubble = null;
    const repaint = (cursor) => {
      if (!bubble) return;
      const toolsHtml = ctx.tools.length ? `<div class="tool-list">${ctx.tools.map(toolChip).join("")}</div>` : "";
      bubble.innerHTML = toolsHtml + md(ctx.full);
      bubble.classList.toggle("typing-cursor", !!cursor);
      scrollBottom();
    };
    // streamLoop 统一走增量接口；恢复场景退化为全量渲染
    ctx.repaint = repaint;
    ctx.addText = (delta) => { ctx.full += delta; repaint(true); };
    ctx.addTool = (tool) => { ctx.tools.push(tool); repaint(true); };
    ctx.setCursor = (on) => repaint(on);
    ctx.smartScroll = () => scrollBottom();
    ctx.syncTip = () => {};

    const aiNode = msgNode("assistant", "");
    bubble = aiNode.querySelector(".msg-bubble");
    messagesEl.appendChild(aiNode);
    repaint(false);
    setStreaming(true);
    abortCtrl = new AbortController();

    try {
      await streamLoop(saved.taskId, ctx, repaint, abortCtrl);
    } catch { /* 恢复中断（如用户停止），忽略 */ }

    if (ctx.full || ctx.tools.length) {
      const last = conv.messages[conv.messages.length - 1];
      if (!(last && last.role === "assistant" && last.content === ctx.full)) {
        conv.messages.push({ role: "assistant", content: ctx.full, tools: ctx.tools.length ? ctx.tools : undefined });
        saveConvs();
      }
    }
    clearActiveTask();
    setStreaming(false);
    renderMessages();
    scrollBottom();
    if (ctx.normalDone && ctx.full) notifyReply(ctx.full);
  }

  // ---------- 本地通知（仅 Capacitor App 有效，浏览器自动跳过） ----------
  function getLocalNotifications() {
    try { return window.Capacitor?.Plugins?.LocalNotifications || null; } catch { return null; }
  }
  async function ensureNotificationPermission() {
    const LN = getLocalNotifications();
    if (!LN) return;
    try {
      const perm = await LN.checkPermissions();
      if (perm.display !== "granted") await LN.requestPermissions();
      await LN.createChannel({ id: "reply_channel", name: "回复通知", description: "agent-mini 收到回复时提醒", importance: 4, vibration: true });
    } catch {}
  }
  async function notifyReply(text) {
    const LN = getLocalNotifications();
    if (!LN) return;
    try {
      const plain = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*`>_~\[\]()!\-|]/g, "").replace(/\s+/g, " ").trim();
      const body = plain ? plain.slice(0, 60) + (plain.length > 60 ? "…" : "") : "点击查看完整回复";
      await LN.schedule({ notifications: [{ id: Date.now(), title: "agent-mini 收到回复", body, channelId: "reply_channel" }] });
    } catch {}
  }

  function setStreaming(v) {
    streaming = v;
    sendBtn.classList.toggle("streaming", v);
    sendBtn.title = v ? "停止" : "发送";
    sendBtn.innerHTML = v
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3.4 20.4l17.45-7.48c.81-.35.81-1.49 0-1.84L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .72.73 1.2 1.39.91z"/></svg>`;
  }

  // ---------- 事件 ----------
  sendBtn.onclick = () => {
    if (streaming) { abortCtrl?.abort(); return; }
    send(input.value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  }
  input.addEventListener("input", autoGrow);

  $("newChatBtn").onclick = newConv;
  $("toggleSidebar").onclick = closeSidebar;
  $("menuBtn").onclick = () => {
    if (sidebar.classList.contains("collapsed")) openSidebar();
    else closeSidebar();
  };
  $("sidebarOverlay").onclick = closeSidebar;

  document.querySelectorAll(".suggestion-card").forEach((card) => {
    card.onclick = () => send(card.dataset.q);
  });

  // 移动端：从左边缘右滑打开侧栏、左滑关闭侧栏
  let tsX = 0, tsY = 0, tsOn = false;
  document.addEventListener("touchstart", (e) => {
    if (!isMobile()) return;
    tsX = e.touches[0].clientX; tsY = e.touches[0].clientY; tsOn = true;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!isMobile() || !tsOn) return;
    tsOn = false;
    const dx = e.changedTouches[0].clientX - tsX;
    const dy = e.changedTouches[0].clientY - tsY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
    const open = !sidebar.classList.contains("collapsed");
    if (dx > 0 && tsX < 36 && !open) openSidebar();
    else if (dx < 0 && open) closeSidebar();
  }, { passive: true });

  // 复制代码
  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.code).then(() => {
      btn.textContent = "已复制 ✓";
      setTimeout(() => (btn.textContent = "复制"), 1500);
    });
  });

  // 工具调用标签：点击头部展开/折叠详情
  messagesEl.addEventListener("click", (e) => {
    const head = e.target.closest(".tool-head");
    if (!head) return;
    const chip = head.closest(".tool-chip");
    if (chip) chip.classList.toggle("open");
  });

  // 主题
  const savedTheme = localStorage.getItem("am_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("themeBtn").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("am_theme", next);
  };

  // 设置（展示 agent-mini 当前配置）
  $("settingsBtn").onclick = async () => {
    settingsModal.hidden = false;
    const body = $("settingsInfo");
    body.innerHTML = "读取中…";
    try {
      const cfg = await (await fetch("/api/config")).json();
      body.innerHTML = cfg.bridge
        ? `<div class="info-row"><span>Provider</span><b>${esc(cfg.provider)}</b></div>
           <div class="info-row"><span>模型</span><b>${esc(cfg.model)}</b></div>
           <div class="info-row"><span>桥接服务</span><b class="ok">已连接</b></div>
           <p class="info-tip">修改模型或参数请编辑 <code>~/.agent-mini/config.json</code>，然后重启 agent_bridge.py</p>`
        : `<div class="info-row"><span>桥接服务</span><b class="err">未连接</b></div>
           <p class="info-tip">请先启动：<br><code>agent-mini venv 的 python.exe agent_bridge.py</code></p>`;
    } catch {
      body.innerHTML = `<div class="info-row"><span>状态</span><b class="err">后端不可达</b></div>`;
    }
  };
  $("closeSettings").onclick = () => (settingsModal.hidden = true);
  settingsModal.onclick = (e) => { if (e.target === settingsModal) settingsModal.hidden = true; };

  // 当前选中的模型（provider/model），发送时其实无需传给后端——
  // 因为切换模型时已直接改写 config.json，而每次 agent 任务都是新子进程
  // 读配置，所以下一条消息自然就用新模型。这里仅用于 UI 状态展示。
  let currentModel = { provider: "", model: "" };

  // 加载模型列表并填充下拉框；bridgeModel 优先用 /api/models 的实时数据，
  // 失败时回退到 /api/config（只拿当前 provider/model，无法列出全部）
  async function updateBadge() {
    try {
      const r = await fetch("/api/models");
      const data = await r.json();
      if (data.bridge && Array.isArray(data.models) && data.models.length) {
        renderModelPicker(data.models, data.active);
        return;
      }
      // 桥接在线但无模型数据：回退到 /api/config
      const cfg = await (await fetch("/api/config")).json();
      modelBadge.innerHTML = cfg.bridge
        ? `<span class="dot"></span>${esc(cfg.provider)} · ${esc(cfg.model)}`
        : `<span class="dot off"></span>agent-mini (离线)`;
      modelSelect.innerHTML = "";
    } catch {
      modelBadge.innerHTML = `<span class="dot off"></span>agent-mini`;
      modelSelect.innerHTML = "";
    }
  }

  // 渲染模型下拉选择器
  function renderModelPicker(models, activeProvider) {
    modelSelect.innerHTML = "";
    let activeFound = null;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}||${m.model}`;
      opt.textContent = `${m.provider} · ${m.model}`;
      if (m.active || m.provider === activeProvider) {
        opt.selected = true;
        activeFound = m;
      }
      modelSelect.appendChild(opt);
    }
    if (activeFound) {
      currentModel = { provider: activeFound.provider, model: activeFound.model };
    } else if (models.length) {
      currentModel = { provider: models[0].provider, model: models[0].model };
    }
    updateModelBadgeText();
  }

  function updateModelBadgeText() {
    const p = currentModel.provider, m = currentModel.model;
    modelBadge.innerHTML = (p && m)
      ? `<span class="dot"></span>${esc(p)} · ${esc(m)}`
      : `<span class="dot off"></span>…`;
  }

  // 切换模型：调 /api/config 改写 config.json，立即生效
  async function switchModel(value) {
    const [provider, model] = (value || "").split("||");
    if (!provider) return;
    modelBadge.classList.add("switching");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        currentModel = { provider: data.provider || provider, model: data.model || model };
        updateModelBadgeText();
      } else {
        // 切换失败：回退显示
        updateModelBadgeText();
        console.warn("模型切换失败:", data.error);
      }
    } catch (err) {
      updateModelBadgeText();
      console.warn("模型切换请求失败:", err.message);
    } finally {
      modelBadge.classList.remove("switching");
    }
  }
  modelSelect.addEventListener("change", () => switchModel(modelSelect.value));


  // ---------- 启动 ----------
  if (innerWidth <= 768) sidebar.classList.add("collapsed");
  renderConvList();
  renderMessages();
  updateBadge();
  input.focus();
  ensureNotificationPermission();   // 浏览器无 Capacitor，自动跳过
  recoverActiveTask();              // 页面（重）打开时恢复进行中任务
  // 标签页从后台切回（隐藏→可见）时，自动续传进行中的任务
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recoverActiveTask();
  });
})();
