#!/usr/bin/env bash
# 等一批 harbor 跑完，把没拿 reward=1 的题（含异常题）单独补跑一批。
#
# 用法: rerun-failures.sh <主批次 pid> <主批次目录> <补跑 job 名> <model> [额外 harbor 参数...]
# 例:   rerun-failures.sh 12345 /Volumes/T7/biny-evals/jobs/my-run my-run-rerun deepseek-v4.1-flash --n-concurrent 3
set -euo pipefail

main_pid=$1
main_job=$2
rerun_name=$3
model=$4
shift 4

# 密钥必须先就位。看门狗是自动起下一轮的，如果它自己没有密钥环境，
# run-tb21.sh 会不声不响地起一批没有 key 的容器 —— 每道题在启动瞬间就报
# "No model available. Set COMMANDCODE_API_KEY."，整轮白跑（实测废掉 6 道）。
# 与其等两小时后发现，不如在这里立刻死。
if [[ -z "${BINY_EVAL_KEY_FILE:-}" && -z "${COMMANDCODE_API_KEY:-}" && -z "${ZAI_API_KEY:-}" ]]; then
  echo "[$(date '+%F %T')] 没有密钥环境（BINY_EVAL_KEY_FILE / COMMANDCODE_API_KEY），补跑必然全挂，退出。" >&2
  exit 2
fi
export BINY_EVAL_KEY_FILE

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
log_file="$(dirname "$main_job")/${rerun_name}.log"

exec >>"$log_file" 2>&1
echo "[$(date '+%F %T')] 等待主批次 pid=${main_pid} 结束"
while kill -0 "$main_pid" 2>/dev/null; do
  sleep 60
done
echo "[$(date '+%F %T')] 主批次已退出，开始统计未通过的题目"

# 补跑范围 = **跨所有轮次**都还没拿到模型评分的题。理由见 retry_scope.py：
# 只看当前这一轮会把「R1 真判0、R2 基建挂」的题误判成基建失败再补一次 —— 那就是 pass@N，
# 实测一次多算了 13 道。只要某一轮 verifier 给过 reward（0 或 1），这格就定案了。
#
# BINY_EVAL_HISTORY：冒号分隔的历史 job 目录。不设就只看当前这轮。
history="${BINY_EVAL_HISTORY:-$main_job}"
IFS=':' read -r -a history_dirs <<< "$history"
tasks=$(python3 "$repo_root/scripts/evals/harbor/retry_scope.py" "${history_dirs[@]}" "$main_job")

if [[ -z "${tasks//[$'\n' ]/}" ]]; then
  echo "[$(date '+%F %T')] 没有未通过的题目，跳过补跑"
  exit 0
fi

echo "[$(date '+%F %T')] 补跑清单："
echo "$tasks" | sed 's/^/  - /'

args=()
while IFS= read -r name; do
  [[ -n "$name" ]] && args+=(--include-task-name "$name")
done <<<"$tasks"

echo "[$(date '+%F %T')] 启动补跑批次 ${rerun_name}（${#args[@]} 个过滤条件）"
"$repo_root/scripts/evals/harbor/run-tb21.sh" \
  --job-name "$rerun_name" \
  --model "$model" \
  --n-concurrent "${RERUN_CONCURRENCY:-3}" \
  "${args[@]}" \
  "$@"
echo "[$(date '+%F %T')] 补跑批次结束"
