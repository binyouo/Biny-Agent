#!/usr/bin/env python3
"""列出「还没拿到过模型评分」的题 —— 也就是还值得补跑的。

为什么不能只看当前这一轮：`classify_job.py` 是按单轮结果分类的。一道题如果 R1 真判 0、
R2 又碰上基建挂，只看 R2 就会把它判成「基建失败」→ 再补跑一次 → 那是在算 pass@N。
实测这么算会多出 13 道。

这里跨所有轮次看：只要某一轮的 verifier 给出过 reward（0 或 1），这格就已经有模型评分了，
不再补跑 —— 对齐 Maka 的 "one allowed replacement admission"：替换名额只给真正没拿到评分的格。

用法: retry_scope.py <job_dir> [<job_dir> ...]
"""

from __future__ import annotations

import glob
import os
import sys


def trial_dirs(job_dir: str, task: str) -> list[str]:
    return glob.glob(os.path.join(job_dir, f"{task}__*"))


def has_model_score(job_dir: str, task: str) -> bool:
    """verifier 真的跑完并写下 reward（0 或 1）= 这格有模型评分了。"""

    return any(
        os.path.exists(os.path.join(trial, "verifier", "reward.txt"))
        for trial in trial_dirs(job_dir, task)
    )


def tasks_seen(job_dirs: list[str]) -> set[str]:
    seen: set[str] = set()
    for job_dir in job_dirs:
        for trial in glob.glob(os.path.join(job_dir, "*__*")):
            seen.add(os.path.basename(trial).split("__")[0])
    return seen


def main() -> int:
    job_dirs = [d for d in sys.argv[1:] if d and os.path.isdir(d)]
    if not job_dirs:
        print("retry_scope.py: 需要至少一个存在的 job 目录", file=sys.stderr)
        return 2
    pending = sorted(
        task
        for task in tasks_seen(job_dirs)
        if not any(has_model_score(job_dir, task) for job_dir in job_dirs)
    )
    print("\n".join(pending))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
