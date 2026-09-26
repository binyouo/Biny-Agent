#!/usr/bin/env bash
# 跑 Terminal-Bench 2.1。一个入口，所有模型都走这里。
#
# 模型怎么指定（二选一）：
#   1) --model <预设名>     查 model-presets.json（deepseek-v4.1-flash / grok / ...）
#   2) BINY_EVAL_* 环境变量  新模型不用改任何代码，见 model-presets.json 的 envDriven
#
# 其余参数原样透传给 harbor run，例如：
#   ./run-tb21.sh --job-name my-run --model deepseek-v4.1-flash --n-concurrent 3
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
harbor_dir="$repo_root/scripts/evals/harbor"

# 密钥文件（可选）：评测密钥不落 git，用 chmod 600 的文件来喂。
if [[ -n "${BINY_EVAL_KEY_FILE:-}" ]]; then
  if [[ ! -f "$BINY_EVAL_KEY_FILE" ]]; then
    echo "BINY_EVAL_KEY_FILE 指向的文件不存在：$BINY_EVAL_KEY_FILE" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "$BINY_EVAL_KEY_FILE"
  set +a
fi

# 每个 trial 会建一个 <task>__<hash>__env 网络。批次被强杀时 harbor 不会清理它们，
# 攒十几个就把 Docker 的默认地址池吃光，之后所有 trial 都卡在
# "all predefined address pools have been fully subnetted"（实测一次报废 83/89 道）。
if command -v docker >/dev/null 2>&1; then
  for network in $(docker network ls --format '{{.Name}}' | grep "__env" || true); do
    docker network rm "$network" >/dev/null 2>&1 || true
  done
fi

verifier_env_args=()
if [[ -f "$harbor_dir/verifier-env.sh" ]]; then
  while IFS= read -r line; do
    [[ -z "${line// }" || "$line" == \#* ]] && continue
    verifier_env_args+=(--verifier-env "$line")
  done < <(grep -vE '^\s*(#|$)' "$harbor_dir/verifier-env.sh")
fi

cd "$repo_root"
export PYTHONPATH="$repo_root${PYTHONPATH:+:$PYTHONPATH}"

exec harbor run \
  --jobs-dir "${BINY_EVAL_JOBS_DIR:-/Volumes/T7/biny-evals/jobs}" \
  --path .agent/harbor/tb21-tasks-full/tasks \
  --agent scripts.evals.harbor.biny_agent:BinyAgent \
  --verifier scripts.evals.harbor.fast_verifier:FastVerifier \
  --n-attempts "${BINY_EVAL_ATTEMPTS:-1}" \
  --agent-timeout-multiplier "${BINY_EVAL_AGENT_TIMEOUT_MULTIPLIER:-1}" \
  --agent-setup-timeout-multiplier 6 \
  --verifier-timeout-multiplier 4 \
  --max-retries 0 \
  "${verifier_env_args[@]}" \
  --yes \
  "$@"
