#!/usr/bin/env python3
"""随时看 dsv4.1 的 TB2.1 成绩 —— 跨所有轮次汇总，不受"只看当前批次"的影响。

用法:
    python3 scripts/evals/harbor/score.py            # 一行汇总
    python3 scripts/evals/harbor/score.py -v         # 再列出三类题名
    python3 scripts/evals/harbor/score.py --watch    # 每 30 秒刷新
"""

from __future__ import annotations

import argparse
import glob
import os
import time

JOBS_DIR = "/Volumes/T7/biny-evals/jobs"
TASKS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "../../../.agent/harbor/tb21-tasks-full/tasks"
)
TAG = "dsv41"


def collect() -> tuple[set[str], set[str], set[str]]:
    job_dirs = [
        d
        for d in glob.glob(os.path.join(JOBS_DIR, "*"))
        if os.path.isdir(d)
        and TAG in os.path.basename(d)
        and os.path.exists(os.path.join(d, "result.json"))
    ]
    passed: set[str] = set()
    failed: set[str] = set()
    for job_dir in job_dirs:
        for trial in glob.glob(os.path.join(job_dir, "*__*")):
            task = os.path.basename(trial).split("__")[0]
            reward = os.path.join(trial, "verifier", "reward.txt")
            if not os.path.exists(reward):
                continue
            try:
                value = open(reward).read().strip()
            except OSError:
                continue
            if value == "1":
                passed.add(task)
            elif value == "0":
                failed.add(task)
    failed -= passed
    tasks = {
        os.path.basename(p.rstrip("/"))
        for p in glob.glob(os.path.join(TASKS_DIR, "*"))
        if os.path.isdir(os.path.join(p, "tests"))
    }
    return passed, failed, tasks - passed - failed


def render(verbose: bool) -> str:
    passed, failed, pending = collect()
    total = len(passed) + len(failed) + len(pending)
    lines = [
        f"✅ 通过 {len(passed)}/{total} = {100 * len(passed) / total:.1f}%"
        f"   ❌ 判0 {len(failed)}   ⏳ 还没跑完 {len(pending)}"
    ]
    if verbose:
        lines.append("\n通过: " + ", ".join(sorted(passed)))
        lines.append("\n判0: " + ", ".join(sorted(failed)))
        lines.append("\n还没跑完: " + (", ".join(sorted(pending)) or "（无）"))
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("--watch", action="store_true", help="每 30 秒刷新")
    args = parser.parse_args()
    while True:
        if args.watch:
            os.system("clear")
            print(time.strftime("%Y-%m-%d %H:%M:%S"), "\n")
        print(render(args.verbose))
        if not args.watch:
            return 0
        time.sleep(30)


if __name__ == "__main__":
    raise SystemExit(main())
