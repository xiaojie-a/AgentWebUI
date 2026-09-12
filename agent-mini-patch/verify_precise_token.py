#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_precise_token.py —— 在 xem 上验证「精确 Token」链路

A) 直接调用 provider.chat_stream，检查返回的 ChatResponse.usage 是否有真实计数
   （这一条验证 providers/ollama.py 的补丁）
B) 走 bridge HTTP：POST /chat → 轮询 /task/<id>/state，检查 last_prompt_tokens / usage
   （这一条验证 ollama.py → _UsageTracker → done 事件 → /api/task 全链路）

用 pipx venv 的 python 运行：
  ~/.local/share/pipx/venvs/agent-mini/bin/python verify_precise_token.py
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.request


def hdr(t):
    print("\n" + "=" * 62)
    print(t)
    print("=" * 62)


async def part_a():
    hdr("A) provider.chat_stream 的 usage（ollama.py 补丁验证）")
    from agent_mini.config import load_config
    from agent_mini.providers import create_provider

    cfg = load_config()
    print("config provider =", cfg.get("provider"), "| model =", cfg.get("model"))
    print("ollama cfg      =", json.dumps(cfg.get("ollama", {}), ensure_ascii=False))
    p = create_provider(cfg)
    print("provider =", p.name, "/", p.model_name)

    deltas: list[str] = []
    thinks: list[str] = []

    async def on_delta(d):
        deltas.append(d)

    async def on_thinking(t):
        thinks.append(t)

    t0 = time.time()
    r = await asyncio.wait_for(
        p.chat_stream(
            [{"role": "user", "content": "只回复两个字：收到"}],
            on_delta=on_delta, tools=None, temperature=0.1,
            on_thinking=on_thinking,
        ),
        timeout=240,
    )
    dt = time.time() - t0
    print(f"耗时 {dt:.1f}s")
    print("usage           =", r.usage)
    print("content         =", repr((r.content or "")[:80]))
    print("delta 累计字符  =", sum(len(d) for d in deltas))
    print("thinking 字符   =", sum(len(t) for t in thinks))
    ok = bool(r.usage) and r.usage.get("prompt_tokens", 0) > 0
    print(">>> A 结论:", "PASS（有真实 prompt_tokens）" if ok else "FAIL（usage 为空）")
    await p.close()
    return ok


def part_b():
    hdr("B) bridge 全链路：/chat → /task/<id>/state")
    base = "http://127.0.0.1:8765"
    sid = "verify-token-" + str(int(time.time()))
    body = json.dumps({"message": "只回复两个字：收到", "session_id": sid}).encode()
    req = urllib.request.Request(base + "/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print("!! /chat 失败:", e)
        return False
    tid = j.get("task_id")
    print("task_id =", tid, "| status =", j.get("status"))

    deadline = time.time() + 300
    st = None
    while time.time() < deadline:
        time.sleep(3)
        try:
            with urllib.request.urlopen(f"{base}/task/{tid}/state", timeout=15) as r:
                st = json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            print("  轮询出错:", e)
            continue
        print(f"  [{int(time.time() - (deadline - 300)):>4}s] status={st.get('status')} "
              f"usage={st.get('usage')} last_prompt_tokens={st.get('last_prompt_tokens')}")
        if st.get("status") not in ("running", "pending"):
            break

    if not st:
        print("!! 没拿到 state")
        return False
    print("\n最终 state:")
    print(json.dumps({k: st[k] for k in st if k != "content"}, ensure_ascii=False, indent=2)[:900])
    ok = (st.get("last_prompt_tokens", 0) or 0) > 0
    print(">>> B 结论:", "PASS（bridge 带出真实 last_prompt_tokens）" if ok else "FAIL（last_prompt_tokens=0）")
    return ok


if __name__ == "__main__":
    a = asyncio.run(part_a())
    b = part_b()
    hdr("汇总")
    print("A provider.chat_stream usage :", "PASS" if a else "FAIL")
    print("B bridge 全链路               :", "PASS" if b else "FAIL")
