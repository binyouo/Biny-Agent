# Harbor + Terminal-Bench 2.1

把 Biny 的 headless CLI 接进 Harbor。Terminal-Bench 的 verifier 负责最终评分，Biny 的回答文本不参与判分。

## 前置条件

- 已安装 Harbor：`uv tool install harbor`
- 已启动 Docker Desktop（每道题一个容器）
- 对应模型的 API key 在环境里，或用 `BINY_EVAL_KEY_FILE` 指向一个 chmod 600 的密钥文件

## 目录

| 文件 | 作用 |
| --- | --- |
| `biny_agent.py` | **唯一的 adapter**。Harbor 的 `BaseAgent` 实现，模型无关 |
| `model-presets.json` | 模型/provider 预设表。加模型改这里，不改代码 |
| `run-tb21.sh` | 唯一入口。清 docker 网络池 → 组装 verifier env → 调 `harbor run` |
| `rerun-failures.sh` | 等主批次跑完，把没拿 reward=1 的题单独补跑一批 |
| `verifier-env.sh` | 交给 verifier 的 `KEY=VALUE` 列表（由 `run-tb21.sh` 转成 `--verifier-env`） |
| `classify_job.py` | 按 `docs/evaluation-plan.md` 的状态模型给一个 job 的失败分流 |
| `merge_results.py` | 跨多个 job 合并结果（union / latest） |
| `fast_verifier.py` | verifier 快速预检 |
| `legacy/` | 旧的 zai 专用路径，只为复现历史成绩保留 |

## 跑

```bash
# 预设模型（查 model-presets.json）
BINY_EVAL_KEY_FILE=~/.config/alma/eval-keys/commandcode.env \
  ./run-tb21.sh --job-name biny-dsv41-tb21 --model deepseek-v4.1-flash --n-concurrent 3

# 全新模型：只给环境变量，adapter 一行都不用改
BINY_EVAL_PROVIDER=acme \
BINY_EVAL_BASE_URL=https://api.acme.dev/v1 \
BINY_EVAL_MODEL=acme-ultra-9 \
BINY_EVAL_API_KEY_ENV=ACME_API_KEY \
  ./run-tb21.sh --job-name biny-acme-tb21 --n-concurrent 3
```

补跑（等主批次结束自动触发）：

```bash
nohup ./rerun-failures.sh <主批次pid> <主批次目录> <补跑job名> deepseek-v4.1-flash >/dev/null 2>&1 &
```

## 两条路不要混

- **这条（`biny_agent.py`）**：adapter 在容器外生成 config → 装进容器 → 跑 `biny run`。日常用这条。
- **`legacy/` 那条（`zai_bench.py`）**：zai 专用，模型表写死。只在复现 GLM 5.3 Flash 那批成绩时用。

## 容器网络的坑（吃过三次亏，写下来）

容器里的 DNS 会被宿主 Clash 的 fake-ip 接管（解析到 `fdfe:dcba:9876::/48`），流量绕宿主 TUN 走一圈，
实测单次请求成功率只有 **93~97%**。单次抖动没事，但凡是「要求连续多次成功」的环节都会被放大成整题报废：

| 环节 | 表现 | 对策 |
| --- | --- | --- |
| 装 biny 依赖（上百个请求） | `npm error network` | npm 重试预算 + runtime 缓存（装一次，后续容器直接解压） |
| 模型连续调 API | `Connect Timeout Error` | provider `retry` |
| verifier 现场下 uv | `uvx: command not found` → 判 0 分 | setup 阶段预铺 uv/uvx/pytest + `--verifier-env` |

**还有一条不是网络的**：强杀 harbor 不会清理它建的 `<task>__<hash>__env` docker 网络，
攒十几个就把 Docker 默认地址池耗尽，之后所有 trial 都起不来容器。
`run-tb21.sh` 每次启动前会清一遍。

## 操作纪律

1. **改完 adapter 先在真容器里验 setup**，再上批次。跳过这步换来的是一个批次全灭。
2. **凡是要 kill harbor，之后清 docker 网络**。
3. **并发不能热改**：`n_concurrent_trials` 改过之后 `job resume` 会拦两道（config 比对 + `lock.json` 指纹）。
   绕过：SIGTERM → 改 `config.json` → 移走 `lock.json` → `harbor job resume -p <job_dir>`。
4. **被自己 bug / 环境打掉的 trial 记录要挪走**（`jobs/_archive/`），别留在主目录里冒充模型失败。

结果和轨迹默认写入 `jobs/`，不要提交到 Git。
