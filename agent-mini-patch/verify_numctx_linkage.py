# -*- coding: utf-8 -*-
"""[AgentWebUI] 验证 AgentLoop 的"有效上下文"是否跟随 config.numCtx 联动。

用法（任选其一）：
    本机 :  C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\agent-mini\\Scripts\\python.exe verify_numctx_linkage.py
    xem  :  ~/.local/share/pipx/venvs/agent-mini/bin/python verify_numctx_linkage.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# 允许显式传入 site-packages 根（默认靠已安装环境）
if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])

from agent_mini.agent.loop import AgentLoop          # noqa: E402
from agent_mini.agent.memory import Memory           # noqa: E402


class StubProvider:
    """AgentLoop.__init__ 只用到 provider.model_name。"""

    def __init__(self, model: str) -> None:
        self.model_name = model
        self.name = "ollama"

    async def close(self) -> None:  # pragma: no cover
        pass


def build(num_ctx, model="qwen3:8b", provider="ollama", agent_extra=None):
    prov = {"model": model}
    if num_ctx is not None:
        prov["numCtx"] = num_ctx
    agent_cfg = {"maxIterations": 5}
    if agent_extra:
        agent_cfg.update(agent_extra)
    cfg = {"provider": provider, "providers": {provider: prov}, "agent": agent_cfg}
    mem = Memory(Path(tempfile.gettempdir()) / "ctx_probe_memory.jsonl", max_entries=10)
    return AgentLoop(StubProvider(model), cfg, mem)


CASES = [
    ("numCtx=35840 / qwen3:8b", 35840, "qwen3:8b"),
    ("numCtx=5120  / qwen3:1.7b", 5120, "qwen3:1.7b"),
    ("numCtx=65536 / qwen3:8b", 65536, "qwen3:8b"),
    ("numCtx=8192  / qwen3:8b", 8192, "qwen3:8b"),
    ("无 numCtx / qwen3:8b (回退档位)", None, "qwen3:8b"),
    ("无 numCtx / qwen3:1.7b (回退档位)", None, "qwen3:1.7b"),
]

print("=" * 66)
print(f"{'场景':<32}{'effective':>12}{'压缩阈值':>14}")
print("-" * 66)
for label, n, model in CASES:
    ag = build(n, model)
    thr = int(ag._effective_ctx * ag._compact_ratio)
    print(f"{label:<32}{ag._effective_ctx:>12}{thr:>14}")

ag = build(10000, "qwen3:8b", agent_extra={"compactRatio": 0.6, "compactTargetRatio": 0.3})
print("-" * 66)
print(
    "自定义比例 compactRatio=0.6 / target=0.3 ->",
    f"effective={ag._effective_ctx}",
    f"阈值={int(ag._effective_ctx * ag._compact_ratio)}",
    f"目标={int(ag._effective_ctx * ag._compact_target_ratio)}",
)

# provider 名缺失时的兜底：取任一有 numCtx 的 provider
cfg = {
    "provider": "not-exist",
    "providers": {"ollama": {"model": "qwen3:8b", "numCtx": 20000}},
    "agent": {"maxIterations": 5},
}
mem = Memory(Path(tempfile.gettempdir()) / "ctx_probe_memory.jsonl", max_entries=10)
ag = AgentLoop(StubProvider("qwen3:8b"), cfg, mem)
print("provider 名不存在时兜底 ->", ag._effective_ctx, "(期望 20000)")
print("=" * 66)
