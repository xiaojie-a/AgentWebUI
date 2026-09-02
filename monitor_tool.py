#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""agent-mini WebUI 本机监控工具（电量 / CPU / 内存）→ monitor.json，每 2 秒刷新。

Android/termux 环境：/sys/class/power_supply 与 /proc/stat 等源被 SELinux 限制，
普通 termux uid 不可读，因此采样**优先 su -c 以 root 执行**；root 不可用/失败时
自动退回普通执行，读到什么算什么，读不到就置 null（诚实，不假报）。

由 watchdog.sh 守护启动：bash watchdog.sh 会 ensure_proc monitor。
输出: 本文件同目录 monitor.json（供 server.js /api/monitor 读取）。
"""
import json
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "monitor.json")
INTERVAL = 2.0


def sh(cmd: str, timeout: int = 4):
    """优先 su -c（root）执行，失败退回普通 sh 执行。返回 strip 后文本或 None。"""
    try:
        p = subprocess.run(["su", "-c", cmd], capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 and (p.stdout or "").strip():
            return p.stdout.strip()
    except Exception:
        pass
    try:
        p = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=timeout)
        if p.returncode == 0 and (p.stdout or "").strip():
            return p.stdout.strip()
    except Exception:
        pass
    return None


def read_int(path):
    v = sh("cat %s 2>/dev/null" % path)
    if not v:
        return None
    try:
        return int(v.strip().split()[0])
    except ValueError:
        return None


# 上次 /proc/stat 采样（cpu 占用需两次采样差值）
_last_stat = None


def cpu_usage():
    """CPU 总占用 %（两次 /proc/stat 差值，间隔即本轮 sleep 前一次 + 当前一次）。"""
    global _last_stat
    s = sh("cat /proc/stat 2>/dev/null | head -1")
    if not s or not s.startswith("cpu"):
        return None
    parts = s.split()
    try:
        nums = [int(x) for x in parts[1:8]]
    except ValueError:
        return None
    total = sum(nums)
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)  # idle + iowait
    if _last_stat:
        l_total, l_idle = _last_stat
        dt = total - l_total
        di = idle - l_idle
        if dt > 0:
            _last_stat = (total, idle)
            return round(max(0.0, min(100.0, (1.0 - di / dt) * 100.0)), 1)
    _last_stat = (total, idle)
    return None


def sample():
    bat_cap = read_int("/sys/class/power_supply/battery/capacity")
    bat_status = sh("cat /sys/class/power_supply/battery/status 2>/dev/null")
    bat_temp_raw = read_int("/sys/class/power_supply/battery/temp")
    temp_c = round(bat_temp_raw / 10.0, 1) if bat_temp_raw is not None else None
    cpu = cpu_usage()
    mem = None
    mi = sh("cat /proc/meminfo 2>/dev/null | grep -E 'MemTotal|MemAvailable'")
    if mi:
        kv = {}
        for line in mi.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                try:
                    kv[parts[0].rstrip(":")] = int(parts[1])
                except ValueError:
                    pass
        if kv.get("MemTotal"):
            mem = round((1.0 - kv.get("MemAvailable", 0) / kv["MemTotal"]) * 100.0, 1)
    return {
        "ts": int(time.time() * 1000),
        "battery": {"percent": bat_cap, "status": (bat_status or "").strip() or None,
                    "temp_c": temp_c},
        "cpu": {"usage": cpu},
        "mem": {"usage": mem},
    }


def main():
    print("monitor_tool started, out=%s" % OUT, flush=True)
    while True:
        try:
            data = sample()
            tmp = OUT + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, OUT)
        except Exception as e:  # noqa: BLE001
            print("sample error: %s" % e, flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
