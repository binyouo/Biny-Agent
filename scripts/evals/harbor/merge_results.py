#!/usr/bin/env python3
"""按官方 verifier reward 合并多轮 Harbor 跑批，生成可复现的 Pass@1 汇总。

背景：09-16 那份 dashboard 上的 "44 / 89 = 49.44%" 是多轮跑批取并集算出来的，
但当时没有留下脚本，事后谁都复现不出来。这个脚本把口径固定下来。

Verifier reward 是唯一 pass/fail 来源；执行异常单独显示。若 Agent 超时但 Harbor 仍取得
可信 verifier reward，该 reward 仍参与通过率。没有 reward 的 trial 不会被脚本虚构成 pass/fail。

两种口径，别混着用：
  --mode union    某题只要在**任意一轮**通过就算通过（跨轮取最好成绩）。
                  这是历史 dashboard 用的口径，会随时间只增不减。
  --mode latest   每道题只取**最后一次**跑批的结果（单轮口径，反映当前水平）。

用法:
  python3 merge_results.py --mode union  --before 2026-09-17 /Volumes/T7/biny-evals/jobs
  python3 merge_results.py --mode latest /Volumes/T7/biny-evals/jobs
  python3 merge_results.py --mode union  --tag flash /Volumes/T7/biny-evals/jobs
"""
import os
import re
import sys
import json
import argparse
from collections import defaultdict


def iter_runs(root):
    for base, _, files in os.walk(root):
        if "result.json" not in files:
            continue
        path = os.path.join(base, "result.json")
        try:
            data = json.load(open(path))
        except Exception:
            continue
        evals = (data.get("stats") or {}).get("evals") or {}
        for _, stats in evals.items():
            reward = (stats.get("reward_stats") or {}).get("reward") or {}
            passed = {x.split("__")[0] for x in reward.get("1.0", [])}
            failed = {x.split("__")[0] for x in reward.get("0.0", [])}
            if not passed and not failed:
                continue
            yield {
                "name": os.path.basename(base.rstrip("/")),
                "dir": base,
                "started": (data.get("started_at") or "")[:19],
                "finished": (data.get("finished_at") or "")[:19],
                "n": data.get("n_total_trials"),
                "passed": passed,
                "failed": failed,
                "exceptions": {k: len(v) for k, v in (stats.get("exception_stats") or {}).items()},
            }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--mode", choices=("union", "latest"), default="union")
    ap.add_argument("--tag", default="", help="只计入 job 名含该子串的跑批")
    ap.add_argument("--before", default="", help="只计入 started_at 早于该日期的跑批 (YYYY-MM-DD)")
    ap.add_argument("--after", default="", help="只计入 started_at 不早于该日期的跑批")
    ap.add_argument("--total", type=int, default=89, help="题目总数，用于算分母")
    ap.add_argument("--show", action="store_true", help="逐题列出出处")
    args = ap.parse_args()

    runs = [r for r in iter_runs(args.root) if r["started"] or r["finished"]]
    if args.tag:
        runs = [r for r in runs if args.tag in r["name"]]
    if args.before:
        runs = [r for r in runs if (r["started"] or r["finished"])[:10] < args.before]
    if args.after:
        runs = [r for r in runs if (r["started"] or r["finished"])[:10] >= args.after]
    if not runs:
        print("没有匹配的跑批"); return

    runs.sort(key=lambda r: r["started"] or r["finished"])

    print("计入口径: %s%s%s   跑批数: %d" % (
        args.mode,
        "   tag=%s" % args.tag if args.tag else "",
        "   < %s" % args.before if args.before else "",
        len(runs)))
    print()

    if args.mode == "union":
        best, source = {}, {}
        for r in runs:
            for t in r["passed"]:
                if t not in best:
                    best[t] = True
                    source[t] = r["name"]
        passed = set(best)
        fail_runs = defaultdict(int)
        for r in runs:
            for t in r["failed"]:
                fail_runs[t] += 1
        print("  并集通过: %d / %d = %.2f%%" % (len(passed), args.total, len(passed) / args.total * 100))
        if source:
            print()
            print("  每题最早通过的轮次:")
            for t in sorted(passed):
                print("    %-44s %s" % (t, source[t][:60]))
    else:
        last = {}
        for r in runs:
            for t in r["passed"]:
                last[t] = (r["started"] or r["finished"], r["name"], True)
            for t in r["failed"]:
                if t not in last or last[t][2] is not True:
                    last[t] = (r["started"] or r["finished"], r["name"], False)
        passed = {t for t, v in last.items() if v[2] is True}
        print("  最后一次口径通过: %d / %d = %.2f%%" % (len(passed), args.total, len(passed) / args.total * 100))
        print("  （只统计出现在最后一次结果里的题，覆盖 %d 题）" % len(last))

    print()
    print("  各轮单独成绩:")
    for r in runs:
        tot = len(r["passed"]) + len(r["failed"])
        print("    %-56s %s  %2d/%-2d  %s" % (
            r["name"][:56], (r["started"] or r["finished"])[:16], len(r["passed"]), tot,
            r["exceptions"] or ""))


if __name__ == "__main__":
    main()
