#!/usr/bin/env python3
"""按 verifier reward 计 Pass@1，并独立保留 Harbor 执行状态。

超时不覆盖 verifier 结果：reward=1 仍是 pass，reward=0 仍是 fail；状态记录
Agent 是否在预算内结束。只有缺少可信 verifier reward 的 cell 不进入 Pass@1。

用法: python3 classify_job.py <job_dir> [<job_dir> ...]
"""
import os
import re
import sys
import json
from collections import Counter, defaultdict

INFRA_SIGNS = [
    (r"version `GLIBC_[\d.]+' not found", "verifier 预置 python 的 glibc 基线过高"),
    (r"Verifier dependencies failed preflight", "verifier 依赖 preflight 硬失败"),
    (r"502\s+Bad Gateway", "apt 源 502"),
    (r"Could not get lock|dpkg frontend lock", "dpkg 锁争用"),
    (r": line \d+: [\w.-]+: command not found", "verifier 缺命令"),
    (r"tls handshake eof|Request failed after 3 retries", "外网拉包失败"),
    (r"ECONNRESET|network aborted|network connectivity", "npm 外网连接中断"),
    (r"provider_error|Cannot connect to API|Connect Timeout Error|socket disconnected", "模型 provider 网络/流式连接失败"),
    (r"Command timed out after \d+ seconds|RuntimeError: Command timed out", "harness 外层命令执行超时"),
    (r"No output generated(?:\.|$)|finish chunk", "模型 provider 未返回完整流"),
    (r"FileNotFoundError.*Rscript|No such file or directory: 'Rscript'", "任务 verifier 缺少 Rscript"),
    (r"Illegal instruction", "模拟器缺指令(SIGILL)"),
    (r"input/output error|blob sha256:", "docker 镜像层 I/O 错误"),
]
VERIFIER_ENV_SIGNS = [
    (r"No interpreter found for Python [\d.]+", "verifier 缺少目标 Python 解释器"),
    (r"Python downloads are set to 'never'", "verifier 禁止下载目标 Python"),
    (
        r"(?is)(?:E: Failed to fetch|Err:\d+).*?404\s+Not Found",
        "verifier apt 依赖下载返回 404",
    ),
    (
        r"FileNotFoundError:.*No such file or directory: 'sshpass'",
        "verifier 缺少 sshpass",
    ),
]
TEST_SUMMARY = re.compile(r"\d+ (?:passed|failed)")


def load_status(job):
    """从 result.json 读 exception_stats / reward_stats 和 job 完成状态。"""
    p = os.path.join(job, "result.json")
    tmo, rte, cancelled, passed, failed = set(), set(), set(), set(), set()
    meta = {"finished": False, "n_total_trials": None}
    if os.path.exists(p):
        try:
            d = json.load(open(p))
        except Exception:
            d = {}

        stats = d.get("stats") if isinstance(d, dict) else None
        if isinstance(stats, dict):
            meta["n_total_trials"] = d.get("n_total_trials")
            meta["finished"] = bool(
                d.get("finished_at")
                and not stats.get("n_running_trials")
                and not stats.get("n_pending_trials")
            )

        def walk(o):
            if isinstance(o, dict):
                if "exception_stats" in o and isinstance(o["exception_stats"], dict):
                    for k, v in o["exception_stats"].items():
                        names = {x.split("__")[0] for x in v}
                        if "Timeout" in k:
                            tmo.update(names)
                        elif "Cancel" in k:
                            cancelled.update(names)
                        else:
                            rte.update(names)
                rs = o.get("reward_stats")
                if isinstance(rs, dict) and isinstance(rs.get("reward"), dict):
                    passed.update(x.split("__")[0] for x in rs["reward"].get("1.0", []))
                    failed.update(x.split("__")[0] for x in rs["reward"].get("0.0", []))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(d)
    return tmo, rte, cancelled, passed, failed, meta


def classify_task(td):
    """返回 (status, reason, infra_signs)。"""
    vp = os.path.join(td, "verifier", "test-stdout.txt")
    rp = os.path.join(td, "verifier", "reward.txt")
    stdout = open(vp, errors="replace").read() if os.path.exists(vp) else ""
    blob = stdout
    for rel in ("trial.log", "agent/biny.stderr", "agent/biny-result.json"):
        p = os.path.join(td, rel)
        if os.path.exists(p):
            blob += "\n" + open(p, errors="replace").read(400000)

    signs = [label for rx, label in INFRA_SIGNS if re.search(rx, blob)]
    verifier_signs = [
        label for rx, label in VERIFIER_ENV_SIGNS if re.search(rx, stdout)
    ]
    reward = None
    if os.path.exists(rp):
        try:
            reward = float(open(rp).read().strip().split()[0])
        except Exception:
            pass
    ran = bool(TEST_SUMMARY.search(stdout))
    return reward, ran, signs, verifier_signs


def main():
    jobs = sys.argv[1:]
    overall = Counter()
    infra_reasons = Counter()
    rows = []
    for job in jobs:
        job = job.rstrip("/")
        tmo, rte, cancelled, passed, failed, meta = load_status(job)
        seen = set()
        job_rows = []
        task_dirs = sorted(d for d in os.listdir(job) if os.path.isdir(os.path.join(job, d)))
        for t in task_dirs:
            b = t.split("__")[0]
            seen.add(b)
            td = os.path.join(job, t)
            reward, ran, signs, verifier_signs = classify_task(td)
            recorded = b in passed or b in failed or b in tmo or b in rte or b in cancelled
            reward_conflict = b in passed and b in failed
            if reward is None and not reward_conflict:
                if b in passed:
                    reward = 1.0
                elif b in failed:
                    reward = 0.0
            elif reward is not None and (
                (b in passed and reward != 1.0) or (b in failed and reward != 0.0)
            ):
                reward_conflict = True

            if reward_conflict or verifier_signs or reward not in (0.0, 1.0):
                score = "unscored"
            else:
                score = "pass" if reward == 1.0 else "fail"
            timeout_sign = any("超时" in sign for sign in signs)
            if reward_conflict:
                st, why = "ambiguous", "同一 task 的 verifier reward 记录互相冲突"
            elif b in tmo or timeout_sign:
                st = "timeout"
                why = (
                    "Agent 达到时限；verifier reward=%s，按 reward 计分"
                    % ("缺失" if reward is None else f"{reward:g}")
                )
            elif b in rte:
                st, why = "infra_failed", "；".join(signs) or "运行时异常"
            elif b in cancelled:
                st, why = "cancelled", "job/trial 被中止（不计入模型断言失败）"
            elif verifier_signs:
                st, why = "infra_failed", "；".join(verifier_signs)
            elif signs and (
                not ran
                or any("provider" in sign or "流" in sign for sign in signs)
            ):
                st, why = "infra_failed", "；".join(signs)
            elif score == "pass":
                st, why = "completed", ""
            elif score == "fail":
                st, why = "subject_failed", "verifier reward=0"
            elif not os.path.exists(os.path.join(td, "verifier", "reward.txt")) and not recorded:
                st, why = "indeterminate", "无 reward 且无异常记录（可能仍在跑）"
            else:
                st, why = "indeterminate", "没有可信 verifier reward"
            overall[st] += 1
            if st == "infra_failed":
                for s in signs:
                    infra_reasons[s] += 1
            row = {"task": b, "status": st, "reward": reward, "score": score, "reason": why}
            rows.append(row)
            job_rows.append(row)

        # result.json 可能已有任务记录，但 Harbor 因异常/取消没有留下 task 目录。
        # 这类任务不能静默从最终报告中消失。
        for b in sorted((passed | failed | tmo | rte | cancelled) - seen):
            reward_conflict = b in passed and b in failed
            if reward_conflict:
                reward = None
            elif b in passed:
                reward = 1.0
            elif b in failed:
                reward = 0.0
            else:
                reward = None
            score = "unscored" if reward_conflict or reward is None else (
                "pass" if reward == 1.0 else "fail"
            )
            if reward_conflict:
                status = "ambiguous"
            elif b in tmo:
                status = "timeout"
            elif b in cancelled:
                status = "cancelled"
            elif b in rte:
                status = "infra_failed"
            else:
                status = "indeterminate"
            overall[status] += 1
            row = {
                "task": b,
                "status": status,
                "reward": reward,
                "score": score,
                "reason": (
                    "result.json 有记录但缺少 task 目录；verifier reward=%s"
                    % ("缺失" if reward is None else f"{reward:g}")
                ),
            }
            rows.append(row)
            job_rows.append(row)

        if meta["n_total_trials"] is not None and meta["n_total_trials"] != len(job_rows):
            print(
                "警告：result.json n_total_trials=%s，但可分类任务=%d；不要把当前结果当完整分数。"
                % (meta["n_total_trials"], len(job_rows))
            )
        if not meta["finished"]:
            print("警告：result.json 尚未确认 job 完成；本次分类仅供诊断，不应作为最终报告。")

    print("=" * 74)
    print("执行状态分布")
    print("=" * 74)
    tot = sum(overall.values())
    for k in ("completed", "subject_failed", "timeout", "infra_failed", "cancelled", "ambiguous", "indeterminate"):
        n = overall[k]
        print("  %-16s %3d  %5.1f%%" % (k, n, (n / tot * 100) if tot else 0))
    print("  %-16s %3d" % ("总计", tot))

    scored_rows = [row for row in rows if row["score"] in {"pass", "fail"}]
    passed_count = sum(row["score"] == "pass" for row in scored_rows)
    failed_count = sum(row["score"] == "fail" for row in scored_rows)
    if scored_rows:
        print(
            "\n官方 verifier Pass@1: %d/%d = %.1f%%"
            % (
                passed_count,
                len(scored_rows),
                passed_count / len(scored_rows) * 100,
            )
        )
    print(
        "verifier 计分: pass=%d fail=%d unscored=%d"
        % (passed_count, failed_count, len(rows) - len(scored_rows))
    )
    timeout_passes = sum(
        row["status"] == "timeout" and row["score"] == "pass" for row in rows
    )
    if timeout_passes:
        print("超时但 verifier 通过: %d（计入 Pass@1）" % timeout_passes)
    known = tot - overall["indeterminate"]
    print("执行状态 coverage（有明确分类的比例）: %.1f%%" % ((known / tot * 100) if tot else 0))

    if infra_reasons:
        print("\n基础设施失败原因分布")
        for k, v in infra_reasons.most_common():
            print("  %-34s %d" % (k, v))

    print("\ninfra_failed 明细")
    for row in rows:
        if row["status"] == "infra_failed":
            print("  %-44s %s" % (row["task"], row["reason"]))
    print("\nindeterminate 明细")
    for row in rows:
        if row["status"] == "indeterminate":
            print("  %-44s %s" % (row["task"], row["reason"]))

    print("\ncancelled 明细")
    for row in rows:
        if row["status"] == "cancelled":
            print("  %-44s %s" % (row["task"], row["reason"]))

    print("\nambiguous 明细")
    for row in rows:
        if row["status"] == "ambiguous":
            print("  %-44s %s" % (row["task"], row["reason"]))

    out = os.path.join(jobs[0].rstrip("/"), "_status.json")
    json.dump(rows, open(out, "w"), indent=2, ensure_ascii=False)
    print("\n明细 ->", out)


if __name__ == "__main__":
    main()
