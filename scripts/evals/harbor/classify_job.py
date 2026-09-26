#!/usr/bin/env python3
"""按 docs/evaluation-plan.md 的状态模型，把一个 harbor job 的失败分流。

状态定义（与 evaluation-plan.md 对齐）：
  completed       verifier 给出确定 reward=1，且没有冲突记录
  subject_failed  verifier 正常跑完但断言没过
  timeout         Agent 达到外层超时，不混入模型断言失败
  infra_failed    verifier / 容器 / 外部依赖挂了，测试根本没跑出结果
  cancelled       job/trial 被人为中止，不混入模型分母
  ambiguous       同一任务同时出现 reward、超时或运行时异常等冲突记录
  indeterminate   数据缺失，无法判定

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
            result_conflict = sum((b in passed, b in failed, b in tmo, b in rte, b in cancelled)) > 1
            timeout_sign = any("超时" in sign for sign in signs)
            # Agent 超时/运行时异常后，Harbor 仍可能继续执行 verifier 并写 reward=0；
            # 这个 0 是失败后果，不是独立的 subject verdict，不能把它误报为 ambiguous。
            if (b in tmo or timeout_sign) and b not in passed:
                st, why = "timeout", "harness/agent 外层命令执行超时；后续 verifier reward 不计入模型断言失败"
            elif b in rte:
                st, why = "infra_failed", "；".join(signs) or "运行时异常"
            elif b in cancelled:
                st, why = "cancelled", "job/trial 被中止（不计入模型断言失败）"
            elif result_conflict:
                st, why = "ambiguous", "result.json 同时记录互相冲突的终态"
            elif verifier_signs:
                st, why = "infra_failed", "；".join(verifier_signs)
            elif signs and (
                not ran
                or any("provider" in sign or "流" in sign for sign in signs)
            ):
                st, why = "infra_failed", "；".join(signs)
            elif b in tmo:
                st, why = "timeout", "agent 超时（不计入模型断言失败）"
            elif b in passed or (reward == 1.0):
                st, why = "completed", ""
            elif not os.path.exists(os.path.join(td, "verifier", "reward.txt")) and not recorded:
                st, why = "indeterminate", "无 reward 且无异常记录（可能仍在跑）"
            else:
                st, why = "subject_failed", "verifier 正常，断言未过"
            overall[st] += 1
            if st == "infra_failed":
                for s in signs:
                    infra_reasons[s] += 1
            row = (b, st, why)
            rows.append(row)
            job_rows.append(row)

        # result.json 可能已有任务记录，但 Harbor 因异常/取消没有留下 task 目录。
        # 这类任务不能静默从最终报告中消失。
        for b in sorted((passed | failed | tmo | rte | cancelled) - seen):
            overall["indeterminate"] += 1
            row = (b, "indeterminate", "result.json 有记录但缺少 task 目录")
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
    print("状态分布")
    print("=" * 74)
    tot = sum(overall.values())
    for k in ("completed", "subject_failed", "timeout", "infra_failed", "cancelled", "ambiguous", "indeterminate"):
        n = overall[k]
        print("  %-16s %3d  %5.1f%%" % (k, n, (n / tot * 100) if tot else 0))
    print("  %-16s %3d" % ("总计", tot))

    model_outcomes = sum(
        overall[status]
        for status in ("completed", "subject_failed", "timeout", "ambiguous")
    )
    if model_outcomes:
        print(
            "\n排除基建后的执行通过率（超时与冲突按未通过）: %d/%d = %.1f%%"
            % (
                overall["completed"],
                model_outcomes,
                overall["completed"] / model_outcomes * 100,
            )
        )
    known = tot - overall["indeterminate"]
    print("coverage（有明确分类的比例）: %.1f%%" % ((known / tot * 100) if tot else 0))

    if infra_reasons:
        print("\n基础设施失败原因分布")
        for k, v in infra_reasons.most_common():
            print("  %-34s %d" % (k, v))

    print("\ninfra_failed 明细")
    for b, st, why in rows:
        if st == "infra_failed":
            print("  %-44s %s" % (b, why))
    print("\nindeterminate 明细")
    for b, st, why in rows:
        if st == "indeterminate":
            print("  %-44s %s" % (b, why))

    print("\ncancelled 明细")
    for b, st, why in rows:
        if st == "cancelled":
            print("  %-44s %s" % (b, why))

    print("\nambiguous 明细")
    for b, st, why in rows:
        if st == "ambiguous":
            print("  %-44s %s" % (b, why))

    out = os.path.join(jobs[0].rstrip("/"), "_status.json")
    json.dump([{"task": b, "status": s, "reason": w} for b, s, w in rows], open(out, "w"), indent=2, ensure_ascii=False)
    print("\n明细 ->", out)


if __name__ == "__main__":
    main()
