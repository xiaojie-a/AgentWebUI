/* AgentWebUI 前端逻辑（对接本地 agent-mini 桥接服务） */
(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const sidebar = $("sidebar"), sidebarOverlay = $("sidebarOverlay"), convList = $("convList"), messagesEl = $("messages"),
    welcomeEl = $("welcome"), chatScroll = $("chatScroll"), input = $("input"),
    sendBtn = $("sendBtn"), topbarTitle = $("topbarTitle"), modelBadge = $("modelBadge"),
    assistantName = $("assistantName"),
    settingsModal = $("settingsModal"),
    ctxRing = $("ctxRing"), ctxRingArc = $("ctxRingArc"),
    ctxModal = $("ctxModal"), ctxDetail = $("ctxDetail"),
    ctxMaxRange = $("ctxMaxRange"), ctxMaxVal = $("ctxMaxVal"), closeCtx = $("closeCtx");

  // ---------- 状态 ----------
  let conversations = loadConvs();
  let currentId = localStorage.getItem("am_current") || null;
  if (currentId && !conversations.find((c) => c.id === currentId)) currentId = null;
  let streaming = false;
  let abortCtrl = null;
  // 正在流式输出中的"任务气泡"（运行中任务在 send()/recoverActiveTask() 里建的 DOM）。
  // renderMessages 会清空消息区，切走再切回时靠它把还在跑的气泡重新挂回，
  // 避免"模型思考中切历史/刷新后整个输出消失"。
  let liveView = null;

  // 模型工作阶段状态文案（发送后 → 思考/输出/执行工具 动态反馈）
  const TIP_WAIT = "⏳ 等待模型响应……";
  const TIP_THINK = "🧠 模型正在思考……";
  const TIP_OUTPUT = "✍️ 模型正在输出……";
  const TIP_EXEC = "⚙️ 执行命令中……";

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

  // ---------- 上下文用量（发送键旁圆环 + 详情弹窗） ----------
  let ctxMax = 8192;          // 上下文上限（默认 8192；读 config numCtx 覆盖）
  let cfgProvider = "ollama";
  let cfgModel = "";
  const CTX_RING_C = 2 * Math.PI * 15.5;   // 圆环周长（r=15.5）

  function estimateTokens(t) {
    if (!t) return 0;
    const s = String(t);
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.max(1, Math.round(cjk * 0.7 + (s.length - cjk) / 4)); // 粗略估算
  }
  function convUsedTokens(conv) {
    let n = 0;
    for (const m of (conv && conv.messages) || []) n += estimateTokens(m && m.content);
    return n;
  }
  function updateCtxRing() {
    if (!ctxRing || !ctxRingArc) return;
    const used = convUsedTokens(currentConv());
    const pct = ctxMax > 0 ? used / ctxMax : 0;
    const p = Math.min(1, Math.max(0, pct));
    ctxRingArc.style.strokeDasharray = String(CTX_RING_C);
    ctxRingArc.style.strokeDashoffset = String(CTX_RING_C * (1 - p));
    ctxRingArc.classList.toggle("warn", p > 0.8 && p <= 0.95);
    ctxRingArc.classList.toggle("danger", p > 0.95);
    ctxRing.title = `上下文 ${used.toLocaleString()} / ${ctxMax.toLocaleString()} tokens（约 ${Math.round(p * 100)}%）`;
  }
  async function loadCtxConfig() {
    try {
      const cfg = await (await fetch("/api/config")).json();
      if (cfg && cfg.provider) cfgProvider = cfg.provider;
      if (cfg && cfg.model) cfgModel = cfg.model;
      const n = cfg && parseInt(cfg.numCtx, 10);
      if (n && n > 0 && ctxMaxRange) {
        ctxMax = n;
        ctxMaxRange.value = n;
        ctxMaxVal.textContent = n.toLocaleString();
      }
    } catch { /* 后端未就绪：保留默认值 */ }
    updateCtxRing();
  }
  function openCtxModal() {
    if (!ctxModal) return;
    const used = convUsedTokens(currentConv());
    const pct = ctxMax > 0 ? used / ctxMax : 0;
    const conv = currentConv();
    const msgCount = conv ? conv.messages.length : 0;
    const charLen = conv ? conv.messages.reduce((a, m) => a + String((m && m.content) || "").length, 0) : 0;
    ctxDetail.innerHTML =
      `<div class="info-row"><span>已用</span><b>${used.toLocaleString()} tokens</b></div>` +
      `<div class="info-row"><span>占用率</span><b>${Math.round(pct * 100)}%</b></div>` +
      `<div class="ctx-usage-bar"><i class="${pct > 0.8 ? "warn" : ""}${pct > 0.95 ? " danger" : ""}" style="width:${Math.min(100, pct * 100)}%"></i></div>` +
      `<div class="info-row"><span>会话消息</span><b>${msgCount} 条</b></div>` +
      `<div class="info-row"><span>文本长度</span><b>${charLen.toLocaleString()} 字符</b></div>` +
      `<div class="info-row"><span>当前模型</span><b>${esc(cfgProvider)} · ${esc(cfgModel || "?")}</b></div>`;
    ctxMaxRange.value = ctxMax;
    ctxMaxVal.textContent = ctxMax.toLocaleString();
    ctxModal.hidden = false;
  }
  ctxRing && (ctxRing.onclick = openCtxModal);
  closeCtx && (closeCtx.onclick = () => { if (ctxModal) ctxModal.hidden = true; });
  ctxModal && (ctxModal.onclick = (e) => { if (e.target === ctxModal) ctxModal.hidden = true; });
  if (ctxMaxRange) {
    ctxMaxRange.addEventListener("input", () => {
      const v = Number(ctxMaxRange.value);
      ctxMaxVal.textContent = v.toLocaleString();
      // 即时预览：按新上限刷新圆环
      const used = convUsedTokens(currentConv());
      const p = v > 0 ? used / v : 0;
      ctxRingArc.style.strokeDashoffset = String(CTX_RING_C * (1 - Math.min(1, Math.max(0, p))));
    });
    ctxMaxRange.addEventListener("change", async () => {
      const v = Number(ctxMaxRange.value);
      ctxMax = v;
      ctxMaxVal.textContent = v.toLocaleString();
      try {
        const r = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: cfgProvider, numCtx: v }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) console.warn("上下文上限保存失败:", d && d.error);
        else console.log(`[Ctx] 上下文上限 -> ${v}`);
      } catch (e) { console.warn("上下文上限保存失败:", e.message); }
      updateCtxRing();
    });
  }

  // ---------- 轻量 Markdown 渲染 ----------
  function md(src) {
    const codeBlocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang, code: code.replace(/\n$/, "") });
      // 用私用区哨兵字符占位，避免被后续 markdown 列表/段落处理吃掉前后空格导致渲染失败
      return `\uE000${codeBlocks.length - 1}\uE001`;
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
    // 用哨兵字符还原代码块（不依赖前后空格，兼容列表/段落处理后的任意上下文）
    html = html.replace(/\uE000(\d+)\uE001/g, (_, i) => {
      const { lang, code } = codeBlocks[+i];
      return `<pre><div class="code-header"><span>${lang || "code"}</span><button class="copy-btn" data-code="${esc(code)}">复制</button></div><code>${esc(code)}</code></pre>`;
    });
    // 清理 <p><pre>…</pre></p> 这类非法嵌套，让代码块成为独立块级元素
    html = html.replace(/<p>(<pre>[\s\S]*?<\/pre>)<\/p>/g, "$1");
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

  // 工具卡片：摘要行（工具名+参数速览）+ 可展开详情（完整参数 / 执行结果 / 耗时）
  // 规则：工具执行中（尚无 result）默认展开；返回结果后收起（由 renderNode/addTool 控制 open）
  function toolDuration(ms) {
    if (ms === undefined || ms === null || isNaN(ms)) return "";
    return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(2) + "s";
  }

  function toolArgText(v) {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  function toolChip(t) {
    const args = t.arguments || {};
    const hasResult = t.result_preview !== undefined && t.result_preview !== null;
    const rp = hasResult ? String(t.result_preview) : "";
    const isErr = !!(t.is_error || /^(error|exception|执行失败|退出码)/i.test(rp.trim()));

    // 折叠态摘要：参数 key=value 速览
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === "") continue;
      const flat = String(toolArgText(v)).replace(/\s+/g, " ").trim();
      parts.push(`${k}=${flat.slice(0, 40)}${flat.length > 40 ? "…" : ""}`);
    }
    const summary = parts.join(" ") || (hasResult ? rp.replace(/\s+/g, " ").slice(0, 40) : "(执行中…)");

    // 展开态：完整参数（逐参数一块）
    const paramHtml = Object.entries(args)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) =>
        `<div class="tool-block"><span class="tool-lbl">参数 ${esc(k)}</span><pre>${esc(toolArgText(v))}</pre></div>`
      ).join("");

    // 展开态：执行结果（完整、可滚动）
    const timeText = toolDuration(t.duration);
    const resultHtml = hasResult
      ? `<div class="tool-block"><span class="tool-lbl${isErr ? " lbl-err" : ""}">${isErr ? "⚠️ 执行结果" : "执行结果"}</span><pre class="tool-result${isErr ? " tool-result-error" : ""}">${esc(rp)}</pre>${timeText ? `<div class="tool-dur">耗时: ${esc(timeText)}</div>` : ""}</div>`
      : "";

    const head = `<span class="tool-icon">${isErr ? "⚠️" : "🔧"}</span>
      <span class="tool-name">${esc(t.name)}</span>
      <code class="tool-summary">${esc(summary)}</code>
      ${timeText ? `<span class="tool-time">${esc(timeText)}</span>` : ""}
      <span class="tool-toggle">›</span>`;

    const detail = paramHtml || resultHtml
      ? paramHtml + resultHtml
      : `<div class="tool-block"><span class="tool-lbl">状态</span><span>正在执行…</span></div>`;

    return `<div class="tool-chip${isErr ? " error" : ""}">
      <button type="button" class="tool-head">${head}</button>
      <div class="tool-detail">${detail}</div>
    </div>`;
  }

  // 深度思考卡片：复用工具卡片的折叠体系。
  // live=true 表示思考进行中（默认展开 + 呼吸点）；live=false 表示思考完毕（自动折叠，点头部展开阅读）。
  function thinkChipHtml(text, live) {
    const summary = live ? "思考中…" : `${text.length} 字 · 点击展开`;
    const inner = esc(text || "");
    return `<div class="tool-chip think-chip${live ? " thinking open" : ""}">
      <button type="button" class="tool-head">
        <span class="tool-icon">🧠</span>
        <span class="tool-name">深度思考</span>
        <code class="tool-summary">${esc(summary)}</code>
        <span class="tool-toggle">›</span>
      </button>
      <div class="tool-detail">
        <div class="tool-block"><pre>${inner}</pre></div>
      </div>
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
        // 若删除的是正在运行任务的会话：停止任务并清理 live 气泡登记，防止后台空跑/误挂
        const act = getActiveTask();
        if (act && act.convId === c.id) {
          if (act.taskId) stopTask(act.taskId);
          clearActiveTask();
          if (liveView && liveView.convId === c.id) liveView = null;
        }
        // 同步清理 agent-mini 端的会话上下文
        fetch(`/api/session/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => {});
      };
      convList.appendChild(btn);
    }
  }

  function msgNode(role, text, tools, reasoning) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    const avatar = role === "user" ? "🙂" : "✦";
    let content;
    if (role === "user") {
      content = esc(text);
    } else {
      const reasoningHtml = reasoning
        ? `<div class="tool-list">${thinkChipHtml(reasoning, false)}</div>` : "";
      const toolsHtml = tools && tools.length
        ? `<div class="tool-list">${tools.map(toolChip).join("")}</div>` : "";
      content = reasoningHtml + toolsHtml + md(text);
    }
    div.innerHTML = `<div class="msg-avatar">${avatar}</div><div class="msg-bubble">${content}</div>`;
    return div;
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    const conv = currentConv();
    welcomeEl.style.display = conv && conv.messages.length ? "none" : "";
    topbarTitle.textContent = conv ? conv.title : "新对话";
    if (!conv) { updateCtxRing(); return; }
    for (const m of conv.messages) {
      messagesEl.appendChild(msgNode(m.role, m.content, m.tools, m.reasoning));
    }
    // 自愈：若当前会话有"仍在运行的任务气泡"（模型思考/输出中）且它已被 renderMessages
    // 清出文档（如切走再切回、刷新恢复期间），把它重新挂回消息区尾部。
    // streaming 为 true 时该任务的流式回调会继续更新这个节点，视图即恢复。
    if (liveView && liveView.convId === conv.id && streaming && !liveView.aiNode.isConnected) {
      messagesEl.appendChild(liveView.aiNode);
    }
    scrollBottom();
    updateCtxRing();   // 切换/新建/加载会话后刷新上下文圆环
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
              // 注意：ctx.full 统一由 ctx.addText 内部累加（addText 会把 delta 拼进
              // ctx.full 并驱动打字机渲染）。这里若再 ctx.full += data.content 会双加，
              // 导致正文/历史记录整段重复（思考 reasoning 只走 addThink 一条路所以不重复）。
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
            if (data.reasoning) {
              if (ctx.addThink) ctx.addThink(data.reasoning);
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
    liveView = { convId: conv.id, aiNode };   // 登记进行中任务气泡（切走/重渲染后自愈挂回）
    scrollBottom();

    abortCtrl = new AbortController();
    // 有序渲染节点：{type:"text", value} | {type:"tool", tool}
    // 流式过程增量更新（不重建 DOM、不重触发动画），工具卡片按到达顺序插入，不再固定堆在文本上方
    const ctx = { full: "", tools: [], reasoning: "", nodes: [], nodeEls: [], statusTip: TIP_WAIT, phase: "wait", normalDone: false, eventIndex: 0, textShown: 0, drainTimer: null, pendingDone: false };
    bubble.innerHTML = `<div class="stream-body"></div>`;
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
      if (n.type === "think") {
        const el = document.createElement("div");
        el.className = "tool-list";
        el.innerHTML = thinkChipHtml(n.value, n.live !== false);
        return el;
      }
      const el = document.createElement("div");
      el.className = "tool-list";
      el.innerHTML = toolChip(n.tool);
      // 规则：尚无结果（执行中/刚发起）默认展开；已返回结果 → 收起
      const hasRes = n.tool.result_preview !== undefined && n.tool.result_preview !== null;
      if (!hasRes) el.querySelector(".tool-chip")?.classList.add("open");
      return el;
    };

    const rebuildNodes = () => {
      // 从 full/reasoning/tools 重建顺序（结束/恢复/错误兜底用；思考→文本→工具按原顺序）
      ctx.nodes = [];
      ctx.nodeEls = [];
      bodyEl.innerHTML = "";
      if (ctx.reasoning) ctx.nodes.push({ type: "think", value: ctx.reasoning, live: false });
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
      const show = !!ctx.statusTip;
      tipEl.style.display = show ? "" : "none";
      tipEl.textContent = show ? ctx.statusTip : "";
    };

    // 打字机式平滑输出：后端常把整段正文一次性送达，逐字 reveal 消除"崩一下"。
    // ctx.full 始终是完整文本；textNodeIdx 指向唯一的正文节点；drainTimer 定时器按节奏
    // 把 ctx.full 的前缀逐步渲染到该节点，flushText 在结束时补完剩余内容。
    let textNodeIdx = -1;
    const ensureTextNode = () => {
      // 全气泡只保留一个正文节点：正文被工具切段时复用已有节点，避免重复渲染
      const found = ctx.nodes.findIndex((n) => n.type === "text");
      if (found !== -1) { textNodeIdx = found; return found; }
      ctx.nodes.push({ type: "text", value: "" });
      const el = renderNode(ctx.nodes[ctx.nodes.length - 1]);
      bodyEl.insertBefore(el, tipEl);
      ctx.nodeEls.push(el);
      textNodeIdx = ctx.nodeEls.length - 1;
      return textNodeIdx;
    };
    ctx.addText = (delta) => {
      ctx.touch?.();   // 有正文到达：刷新"空窗期等待"计时
      // 正文真正开始前的纯空白噪音（agent-mini 多轮分隔的 \n）直接跳过，
      // 不切"输出中"状态、不建文本节点
      if (delta) {
        const nextFull = ctx.full + delta;
        if (!ctx.full.trim() && !delta.trim()) { ctx.full = nextFull; syncTip(); return; }
        ctx.full = nextFull;
      }
      if (!ctx.full.trim()) return;
      ctx.collapseThink?.(); // 开始输出正文 → 折叠深度思考
      ctx.setPhase("output", TIP_OUTPUT);
      bodyEl.querySelector(".dots")?.remove(); // 兼容旧版残留占位
      ensureTextNode();
      ctx.nodes[textNodeIdx].value = ctx.full; // 值始终为完整文本（结束/恢复可直接渲染）
      ctx.startDrain?.();
      syncTip();
    };
    ctx.startDrain = () => {
      if (ctx.drainTimer) return;
      const tick = () => {
        const el = ctx.nodeEls[textNodeIdx];
        if (!el) { ctx.drainTimer = null; return; }
        if (ctx.textShown >= ctx.full.length) {
          clearInterval(ctx.drainTimer);
          ctx.drainTimer = null;
          if (ctx.pendingDone) { ctx.pendingDone = false; ctx.flushText?.(); scrollBottom(); }
          return;
        }
        // 每次推进少量字符，产生"正在输出"的观感
        ctx.textShown = Math.min(ctx.full.length, ctx.textShown + 2);
        const shown = ctx.full.slice(0, ctx.textShown);
        ctx.nodes[textNodeIdx].value = shown;
        // 打字阶段用纯文本 pre-wrap 逐步追加（不逐帧解析 markdown），
        // 避免每 2 字符一次完整 md 重排导致气泡/滚动"跳一下"
        el.style.whiteSpace = "pre-wrap";
        el.textContent = shown;
      };
      ctx.drainTimer = setInterval(tick, 28);
      tick(); // 立即先补一帧，避免积压文字迟迟不出
    };
    ctx.flushText = () => {
      if (ctx.drainTimer) { clearInterval(ctx.drainTimer); ctx.drainTimer = null; }
      ctx.textShown = ctx.full.length;
      // 只收尾当前正文节点，避免把全文重复写进多个 text 节点（气泡重复字样的根因）
      const n = ctx.nodes[textNodeIdx];
      if (n && n.type === "text") {
        n.value = ctx.full;
        const tel = ctx.nodeEls[textNodeIdx];
        if (tel) {
          tel.style.whiteSpace = "";   // 结束输出：回到正常排版，一次性渲染完整 markdown
          tel.innerHTML = md(ctx.full);
        }
      }
    };

    // 深度思考：整个回答只保留一张卡片；多次工具轮的思考内容累积追加

    ctx.addTool = (tool) => {
      ctx.touch?.();   // 工具事件到达：刷新空窗期计时（含发起/结果）
      // 注意：不在工具到达时折叠思考气泡——保留当前轮思考内容可读；
      // 等下一轮思考或最终正文开始时再折叠（见 addThink/addText）
      bodyEl.querySelector(".dots")?.remove(); // 兼容旧版残留占位
      // bridge 对同一工具发两次事件：先带 arguments（无结果），后带 result_preview（无 arguments）→ 合并到同一节点
      const hasResult = tool.result_preview !== undefined && tool.result_preview !== null;
      const noArgs = !tool.arguments || !Object.keys(tool.arguments).length;
      if (hasResult && noArgs) {
        const last = ctx.nodes[ctx.nodes.length - 1];
        if (last && last.type === "tool") {
          last.tool = Object.assign({}, last.tool, tool); // 合并结果/耗时/错误态
          ctx.nodeEls[ctx.nodeEls.length - 1].innerHTML = toolChip(last.tool);
          ctx.setPhase("wait", TIP_WAIT); // 工具已结束：下一段思考/输出尚未到达 → 等待模型响应
          return;
        }
      }
      ctx.nodes.push({ type: "tool", tool });
      ctx.setPhase("exec", TIP_EXEC); // 工具发起：状态行提示“执行命令中……”
      const el = renderNode(ctx.nodes[ctx.nodes.length - 1]);
      bodyEl.insertBefore(el, tipEl);
      ctx.nodeEls.push(el);
      syncTip();
    };

    // 深度思考：每个"思考轮"独立一个卡片。同一段思考的分块追加到当前卡；
    // 工具结果之后的新一轮思考 → 在工具下方新建一张卡（不再合并进旧卡）。
    ctx.addThink = (delta) => {
      ctx.touch?.();   // 深度思考 token 到达：不再是"干等"，交给思考卡展示
      ctx.setPhase("think", "");   // 卡片本身即状态，隐藏顶部提示行避免重复
      const nodes = ctx.nodes;
      const last = nodes[nodes.length - 1];
      if (last && last.type === "think" && last.live) {
        // 同一段思考的后续分块 → 追加到当前气泡
        ctx.reasoning += delta;
        last.value += delta;
        const el = ctx.nodeEls[nodes.length - 1];
        const pre = el && el.querySelector("pre");
        if (pre) {
          const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
          pre.textContent = last.value;
          if (nearBottom) pre.scrollTop = pre.scrollHeight;
        }
      } else {
        // 新一轮思考（常见于工具结果之后）：
        // 先折叠之前所有老思考气泡，只保留当前轮展开并锁底给用户看
        ctx.collapseThink?.();
        ctx.reasoning += (ctx.reasoning ? "\n\n" : "") + delta;
        nodes.push({ type: "think", value: delta, live: true });
        const el = renderNode(nodes[nodes.length - 1]);
        bodyEl.insertBefore(el, tipEl);
        ctx.nodeEls.push(el);
      }
      syncTip();
    };
    // 思考完毕（开始输出 / 发起工具）→ 折叠思考卡片
    ctx.collapseThink = () => {
      for (let i = 0; i < ctx.nodes.length; i++) {
        const n = ctx.nodes[i];
        if (n.type === "think" && n.live) {
          n.live = false;
          const fresh = renderNode(n);
          ctx.nodeEls[i].replaceWith(fresh);
          ctx.nodeEls[i] = fresh;
        }
      }
    };

    ctx.rebuild = rebuildNodes;
    ctx.syncTip = syncTip;
    // 阶段状态：仅在阶段/文案真正变化时才更新 DOM，避免高频 token 抖动
    ctx.setPhase = (phase, text) => {
      if (ctx.phase === phase && ctx.statusTip === text) return;
      ctx.phase = phase;
      ctx.statusTip = text;
      syncTip();
    };
    ctx.finishTip = () => { ctx.setPhase("done", ""); };
    ctx.setCursor = (on) => bubble.classList.toggle("typing-cursor", !!on);
    ctx.smartScroll = () => {
      const c = chatScroll;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 140) c.scrollTop = c.scrollHeight;
    };
    // 最近一次"真实产出"（思考/正文/工具事件）时间：用于空窗期等待提示
    ctx.lastActivity = Date.now();
    ctx.touch = () => { ctx.lastActivity = Date.now(); };
    syncTip(); // 立即显示“⏳ 等待模型响应……”
    // 空窗期提示：任何真实事件都会 touch()；长时间无产出时提示"等待模型响应 + 已等待秒数"
    const waitWatch = setInterval(() => {
      if (ctx.normalDone || ctx.phase === "done") return;
      if (ctx.phase !== "wait") return;   // 思考卡/输出/工具执行中各自有自己的提示
      const waited = Math.floor((Date.now() - ctx.lastActivity) / 1000);
      if (waited >= 2) {
        ctx.setPhase("wait", `⏳ 等待模型响应……（已等待 ${waited} 秒）`);
      } else {
        ctx.setPhase("wait", TIP_WAIT);
      }
    }, 2000);
    ctx.waitWatch = waitWatch;

    const repaint = (cursor) => {
      // 结束/恢复/错误时的重绘：保留流式过程的有序 nodes（工具与文本交错），不整体重建
      if (!ctx.nodes.length) {
        rebuildNodes(); // 无流式节点（如恢复场景）才用 full/tools 重建
      } else {
        const last = ctx.nodes[ctx.nodes.length - 1];
        if (last && last.type === "text") {
          last.value = ctx.full; // 同步完整文本（含结束/错误追加）
          // 打字机进行中不整体重绘，交给 drain 定时器收尾
          if (!ctx.drainTimer) {
            const tel = ctx.nodeEls[ctx.nodeEls.length - 1];
            if (tel) { tel.style.whiteSpace = ""; tel.innerHTML = md(ctx.full); }
          }
        } else {
          ctx.addText(ctx.full || ""); // 最后节点是工具：补一个文本节点
        }
        syncTip();
      }
      ctx.collapseThink?.(); // 结束/中断兜底：确保思考卡片始终处于折叠态
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
      clearTimeout(ctx.waitWatch);
      // 正常结束时若打字机还在跑，让队列自然播完（done 时刻已收到完整文本）；
      // 错误/中断/无内容则立即补完剩余部分。
      if (ctx.drainTimer) ctx.pendingDone = true;
      else ctx.flushText?.();
      repaint(false);
      ctx.finishTip(); // 结束/停止/出错统一隐藏阶段状态行（放在 repaint 后，避免被重绘重新点亮）
      if (ctx.full || ctx.tools.length || ctx.reasoning) {
        conv.messages.push({
          role: "assistant",
          content: ctx.full,
          tools: ctx.tools.length ? ctx.tools : undefined,
          reasoning: ctx.reasoning || undefined,
        });
        saveConvs();
      }
      clearActiveTask();
      setStreaming(false);
      if (liveView && liveView.aiNode === aiNode) liveView = null; // 任务结束：live 气泡已收尾
      scrollBottom();
      updateCtxRing();   // 回复完成后刷新上下文用量
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
      // 正文可能为空但仍有思考/工具（如中途结束），任一有内容就应收录显示
      const content = st.content || "";
      const hasAny = content || (st.tools && st.tools.length) || st.reasoning;
      if (hasAny) {
        const last = conv.messages[conv.messages.length - 1];
        const dup = last && last.role === "assistant"
          && (last.content || "") === content
          && (last.reasoning || "") === (st.reasoning || "");
        if (!dup) {
          conv.messages.push({
            role: "assistant",
            content,
            tools: st.tools && st.tools.length ? st.tools : undefined,
            reasoning: st.reasoning || undefined,
          });
          saveConvs();
        }
        renderMessages();
        if (st.status === "done" && content) notifyReply(content);
      }
      clearActiveTask();
      return;
    }

    const ctx = { full: st.content || "", tools: st.tools || [], reasoning: st.reasoning || "", nodes: [], nodeEls: [], statusTip: "", phase: "wait", normalDone: false, eventIndex: st.event_count || 0, textShown: 0, drainTimer: null, pendingDone: false };
    let bubble = null;
    let bodyEl = null;
    let tipEl = null;
    let textNodeIdx = -1;

    const aiNode = msgNode("assistant", "");
    bubble = aiNode.querySelector(".msg-bubble");
    bubble.innerHTML = `<div class="stream-body"></div>`;
    bodyEl = bubble.firstElementChild;
    tipEl = document.createElement("div");
    tipEl.className = "waiting-tip";
    tipEl.style.display = "none";
    bodyEl.appendChild(tipEl);
    messagesEl.appendChild(aiNode);
    liveView = { convId: saved.convId, aiNode };

    // ===== 增量渲染（与正常流式流程一致：不重建 DOM、打字机输出、智能滚动，避免气泡跳动/不锁底/token不连续）=====
    const renderNode = (n) => {
      if (n.type === "text") {
        const el = document.createElement("div");
        el.className = "stream-text";
        el.innerHTML = md(n.value);
        return el;
      }
      if (n.type === "think") {
        const el = document.createElement("div");
        el.className = "tool-list";
        el.innerHTML = thinkChipHtml(n.value, n.live !== false);
        return el;
      }
      const el = document.createElement("div");
      el.className = "tool-list";
      el.innerHTML = toolChip(n.tool);
      const hasRes = n.tool.result_preview !== undefined && n.tool.result_preview !== null;
      if (!hasRes) el.querySelector(".tool-chip")?.classList.add("open");
      return el;
    };

    const rebuildNodes = () => {
      ctx.nodes = [];
      ctx.nodeEls = [];
      bodyEl.innerHTML = "";
      // 恢复时思考进行中（尚无正文）→ live=true 默认展开；正文已开始 → live=false 折叠
      if (ctx.reasoning) ctx.nodes.push({ type: "think", value: ctx.reasoning, live: !ctx.full });
      if (ctx.full) ctx.nodes.push({ type: "text", value: ctx.full });
      for (const t of ctx.tools) ctx.nodes.push({ type: "tool", tool: t });
      for (const n of ctx.nodes) {
        const el = renderNode(n);
        bodyEl.appendChild(el);
        ctx.nodeEls.push(el);
      }
      bodyEl.appendChild(tipEl);
      textNodeIdx = ctx.nodes.findIndex((n) => n.type === "text");
    };

    const syncTip = () => {
      tipEl.style.display = ctx.statusTip ? "" : "none";
      tipEl.textContent = ctx.statusTip || "";
    };

    ctx.setPhase = (phase, text) => {
      if (ctx.phase === phase && ctx.statusTip === text) return;
      ctx.phase = phase;
      ctx.statusTip = text;
      syncTip();
    };
    ctx.setCursor = (on) => bubble.classList.toggle("typing-cursor", !!on);
    ctx.smartScroll = () => {
      const c = chatScroll;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 140) c.scrollTop = c.scrollHeight;
    };
    ctx.touch = () => {};

    // 思考卡片折叠（开始输出正文/发起工具时调用）
    ctx.collapseThink = () => {
      for (let i = 0; i < ctx.nodes.length; i++) {
        const n = ctx.nodes[i];
        if (n.type === "think" && n.live) {
          n.live = false;
          const fresh = renderNode(n);
          ctx.nodeEls[i].replaceWith(fresh);
          ctx.nodeEls[i] = fresh;
        }
      }
    };

    // 文本节点：打字机效果（每28ms推进2字符，用textContent避免逐帧markdown重排）
    const ensureTextNode = () => {
      if (textNodeIdx !== -1) return textNodeIdx;
      const found = ctx.nodes.findIndex((n) => n.type === "text");
      if (found !== -1) { textNodeIdx = found; return found; }
      ctx.nodes.push({ type: "text", value: "" });
      const el = renderNode(ctx.nodes[ctx.nodes.length - 1]);
      bodyEl.insertBefore(el, tipEl);
      ctx.nodeEls.push(el);
      textNodeIdx = ctx.nodeEls.length - 1;
      return textNodeIdx;
    };

    ctx.startDrain = () => {
      if (ctx.drainTimer) return;
      const tick = () => {
        const el = ctx.nodeEls[textNodeIdx];
        if (!el) { ctx.drainTimer = null; return; }
        if (ctx.textShown >= ctx.full.length) {
          clearInterval(ctx.drainTimer);
          ctx.drainTimer = null;
          if (ctx.pendingDone) { ctx.pendingDone = false; ctx.flushText?.(); scrollBottom(); }
          return;
        }
        ctx.textShown = Math.min(ctx.full.length, ctx.textShown + 2);
        const shown = ctx.full.slice(0, ctx.textShown);
        ctx.nodes[textNodeIdx].value = shown;
        el.style.whiteSpace = "pre-wrap";
        el.textContent = shown;
      };
      ctx.drainTimer = setInterval(tick, 28);
      tick();
    };

    ctx.flushText = () => {
      if (ctx.drainTimer) { clearInterval(ctx.drainTimer); ctx.drainTimer = null; }
      ctx.textShown = ctx.full.length;
      const n = ctx.nodes[textNodeIdx];
      if (n && n.type === "text") {
        n.value = ctx.full;
        const tel = ctx.nodeEls[textNodeIdx];
        if (tel) { tel.style.whiteSpace = ""; tel.innerHTML = md(ctx.full); }
      }
    };

    ctx.addText = (delta) => {
      if (delta) {
        const nextFull = ctx.full + delta;
        if (!ctx.full.trim() && !delta.trim()) { ctx.full = nextFull; syncTip(); return; }
        ctx.full = nextFull;
      }
      if (!ctx.full.trim()) return;
      ctx.collapseThink?.();
      ctx.setPhase("output", "");
      bodyEl.querySelector(".dots")?.remove();
      ensureTextNode();
      ctx.nodes[textNodeIdx].value = ctx.full;
      ctx.startDrain?.();
      syncTip();
    };

    // 深度思考：增量更新 pre.textContent，不重建 DOM（展开状态自然保留，内部滚动位置不丢失）
    ctx.addThink = (delta) => {
      ctx.setPhase("think", "");
      const nodes = ctx.nodes;
      const last = nodes[nodes.length - 1];
      if (last && last.type === "think" && last.live) {
        ctx.reasoning += delta;
        last.value += delta;
        const el = ctx.nodeEls[nodes.length - 1];
        const pre = el && el.querySelector("pre");
        if (pre) {
          const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
          pre.textContent = last.value;
          if (nearBottom) pre.scrollTop = pre.scrollHeight;
        }
      } else {
        ctx.collapseThink?.();
        ctx.reasoning += (ctx.reasoning ? "\n\n" : "") + delta;
        nodes.push({ type: "think", value: delta, live: true });
        const el = renderNode(nodes[nodes.length - 1]);
        bodyEl.insertBefore(el, tipEl);
        ctx.nodeEls.push(el);
      }
      syncTip();
    };

    ctx.addTool = (tool) => {
      ctx.tools.push(tool);
      ctx.setPhase("tool", "");
      const el = renderNode({ type: "tool", tool });
      bodyEl.insertBefore(el, tipEl);
      ctx.nodeEls.push(el);
      ctx.nodes.push({ type: "tool", tool });
      syncTip();
    };

    ctx.rebuild = rebuildNodes;
    ctx.syncTip = syncTip;

    // 结束/恢复时的重绘：只更新最后节点，不整体重建 DOM
    const repaint = (cursor) => {
      if (!ctx.nodes.length) {
        rebuildNodes();
      } else {
        const last = ctx.nodes[ctx.nodes.length - 1];
        if (last && last.type === "text") {
          last.value = ctx.full;
          if (!ctx.drainTimer) {
            const tel = ctx.nodeEls[ctx.nodeEls.length - 1];
            if (tel) { tel.style.whiteSpace = ""; tel.innerHTML = md(ctx.full); }
          }
        } else if (ctx.full) {
          ctx.addText(ctx.full);
        }
        syncTip();
      }
      // 仅在任务结束时折叠思考卡片；初始化/进行中调用 repaint 不应折叠，否则后续思考 token 会误判为新一轮而新建卡片
      if (ctx.normalDone) ctx.collapseThink?.();
      ctx.setCursor(cursor);
      scrollBottom();
    };
    ctx.repaint = repaint;

    // 先用已有内容渲染（恢复时可能已有部分思考/正文/工具）
    if (ctx.reasoning || ctx.tools.length || ctx.full) {
      rebuildNodes();
      // 恢复时已有正文 → 视为已输出部分，textShown 对齐，后续新 token 从当前位置继续打字
      if (ctx.full && textNodeIdx !== -1) {
        ctx.textShown = ctx.full.length;
        const tel = ctx.nodeEls[textNodeIdx];
        if (tel) { tel.style.whiteSpace = ""; tel.innerHTML = md(ctx.full); }
      }
    } else {
      // 尚无任何内容：显示加载指示
      const dots = document.createElement("span");
      dots.className = "dots";
      dots.innerHTML = "<span></span><span></span><span></span>";
      bodyEl.appendChild(dots);
    }
    // 初始化不调用 repaint()：rebuildNodes 已完成渲染，repaint 会误触发 collapseThink 把进行中的思考卡片置为 live=false
    ctx.setCursor(false);
    scrollBottom();
    setStreaming(true);
    abortCtrl = new AbortController();

    try {
      await streamLoop(saved.taskId, ctx, repaint, abortCtrl);
    } catch { /* 恢复中断（如用户停止），忽略 */ }

    if (ctx.full || ctx.tools.length || ctx.reasoning) {
      const last = conv.messages[conv.messages.length - 1];
      if (!(last && last.role === "assistant" && last.content === ctx.full)) {
        conv.messages.push({
          role: "assistant",
          content: ctx.full,
          tools: ctx.tools.length ? ctx.tools : undefined,
          reasoning: ctx.reasoning || undefined,
        });
        saveConvs();
      }
    }
    clearActiveTask();
    setStreaming(false);
    if (liveView && liveView.aiNode === aiNode) liveView = null; // 恢复任务结束
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

  // 设置（展示 agent-mini 当前配置；2026-09-07 起引擎固定 agent-mini，EffGen 已移除）
  $("settingsBtn").onclick = async () => {
    settingsModal.hidden = false;
    const body = $("settingsInfo");
    body.innerHTML = "读取中…";
    try {
      const cfg = await (await fetch("/api/config")).json();
      assistantName.textContent = "agent-mini";
      body.innerHTML = cfg.bridge
        ? `<div class="info-row"><span>Provider</span><b>${esc(cfg.provider)}</b></div>
           <div class="info-row"><span>模型</span><b>${esc(cfg.model)}</b></div>
           <div class="info-row"><span>引擎</span><b>agent-mini</b></div>
           <div class="info-row"><span>桥接服务</span><b class="ok">已连接</b></div>
           <p class="info-tip">切换模型后，下一条消息自动生效（无需重启）</p>`
        : `<div class="info-row"><span>桥接服务</span><b class="err">未连接</b></div>
           <p class="info-tip">请先启动：<br><code>agent-mini venv 的 python.exe agent_bridge.py</code></p>`;
    } catch {
      body.innerHTML = `<div class="info-row"><span>状态</span><b class="err">后端不可达</b></div>`;
    }
  };
  $("closeSettings").onclick = () => (settingsModal.hidden = true);
  settingsModal.onclick = (e) => { if (e.target === settingsModal) settingsModal.hidden = true; };

  // 引擎固定 agent-mini：顶栏助手名直接显示
  function syncBackend() {
    assistantName.textContent = "agent-mini";
  }

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
    // 只应有一个"当前选中"：
    //  1) 后端明确标记 active 的模型；2) 否则当前 provider 组里的第一个；
    //  3) 否则列表第一个。（旧逻辑给 provider 组内每个模型都设 selected，
    //  浏览器只保留最后一项 → 刷新后显示 ollama 列表最后一个而非当前选择。）
    let chosen = models.find((m) => m.active)
      || models.find((m) => m.provider === activeProvider)
      || models[0] || null;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}||${m.model}`;
      opt.textContent = `${m.provider} · ${m.model}`;
      if (m === chosen) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    if (chosen) {
      currentModel = { provider: chosen.provider, model: chosen.model };
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
  syncBackend();          // 同步设置页引擎复选框
  loadCtxConfig();        // 读取上下文上限并刷新圆环
  input.focus();
  ensureNotificationPermission();   // 浏览器无 Capacitor，自动跳过
  recoverActiveTask();              // 页面（重）打开时恢复进行中任务
  // 标签页从后台切回（隐藏→可见）时，自动续传进行中的任务
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recoverActiveTask();
  });
})();

// ============ 本机实时监控（电量/CPU/内存，每 3 秒刷新） ============
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var elBatt = $("battPct"), elCpu = $("cpuPct"), elStatus = $("sysStatus");
  if (!elBatt && !elCpu) return; // 页面无监控元素（如纯 API 场景）则跳过

  function setText(el, txt, cls) {
    if (!el) return;
    el.textContent = txt;
    if (cls) { el.className = cls; } else if (elBatt) { /* 保留默认 */ }
  }
  function apply(data) {
    var ok = data && data.available !== false;
    if (!ok) {
      setText(elBatt, "--%");
      setText(elCpu, "--%");
      if (elStatus) elStatus.title = "监控未就绪：monitor_tool 未运行";
      return;
    }
    var b = data.battery || {}, c = data.cpu || {};
    var pct = (b.percent == null) ? "--%" : b.percent + "%";
    var usage = (c.usage == null) ? "--%" : c.usage + "%";
    // 低电量（≤20%）标红提醒
    if (b.percent != null && b.percent <= 20) {
      setText(elBatt, pct);
      if (elBatt) elBatt.style.color = "#e5484d";
    } else {
      setText(elBatt, pct);
      if (elBatt) elBatt.style.color = "";
    }
    setText(elCpu, usage);
    if (elStatus) {
      var status = b.status ? (b.status === "Charging" ? "充电中" : b.status === "Full" ? "已充满" : b.status === "Discharging" ? "" : b.status) : "";
      var tip = "电量 " + pct + (status ? "（" + status + "）" : "");
      if (b.temp_c != null) tip += " · 电池 " + b.temp_c + "℃";
      tip += " · CPU " + usage;
      if (data.mem && data.mem.usage != null) tip += " · 内存 " + data.mem.usage + "%";
      elStatus.title = tip + "（每 3 秒刷新）";
    }
  }
  function tick() {
    fetch("/api/monitor", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () { apply(null); });
  }
  tick();
  setInterval(tick, 3000);
})();

// ============ 设置弹窗：停止所有任务按钮 ============
(function () {
  var btn = document.getElementById("stopAllBtn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    if (!window.confirm("确定停止当前所有后台 agent 任务？正在进行的操作会被中断。")) return;
    btn.disabled = true;
    btn.textContent = "⏹ 正在停止…";
    fetch("/api/stop-all", { method: "POST", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var n = (d && d.count != null) ? d.count : 0;
        btn.textContent = n > 0 ? ("✅ 已停止 " + n + " 个任务") : "✅ 当前无运行中任务";
        setTimeout(function () { btn.disabled = false; btn.textContent = "⏹ 停止所有任务"; }, 2500);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "❌ 停止失败，稍后重试";
        setTimeout(function () { btn.textContent = "⏹ 停止所有任务"; }, 2500);
      });
  });
})();
