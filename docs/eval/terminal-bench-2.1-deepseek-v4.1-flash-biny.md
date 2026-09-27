# Terminal-Bench 2.1 — DeepSeek V4.1 Flash（biny）

**Run id:** `biny-dsv41-tb21-20260923`　|　**日期:** 2026-09-23 ~ 09-24　|　**生成:** 2026-09-24 15:00

**Metric:** end-to-end pass@1，由 Terminal-Bench 官方 verifier 判定

**Status:** 原始 Pass@1 评测完成；badcase 重跑记录更新至 2026-09-27

**产物:** `/Volumes/T7/biny-evals/jobs/biny-dsv41-tb21-*`（git-excluded）

**原始逐题结果:** [`terminal-bench-2.1-deepseek-v4.1-flash-biny.csv`](./terminal-bench-2.1-deepseek-v4.1-flash-biny.csv)（截至 2026-09-24；最新 badcase 补测见本报告上节）

---

## 结果（官方榜单口径）

| Model | Agent | Accuracy |
| --- | --- | ---: |
| DeepSeek V4.1 Flash | biny headless CLI | **58/89 (65.2%)** |

## TL;DR

- **end-to-end pass@1 = 58/89 = 65.2%**（每格只取第一次模型评分）
- 28 道被 verifier 判定未通过，另有 2 道首评判 0 后重跑通过（**pass@2，不计入**）
- 1 道（`train-fasttext`）的 0 来自**判分器自身 setup 失败**，测试从未运行 —— 详见可比性声明
- 截至 2026-09-27，跨轮去重后 **75/89 = 84.3%** 的题目至少有一轮 verifier reward=1；这是 best-of-runs 统计，**不是 Pass@1 或公开排行榜分数**
- 原始 Pass@1 逐题结果见文末；本次新增 badcase 重跑见下节

## Badcase 重跑与跨轮去重成绩（截至 2026-09-27）

| 口径 | 通过题数 | 占 89 题 | 说明 |
| --- | ---: | ---: | --- |
| 原始官方口径 Pass@1 | 58 | 65.2% | 保持不变；每题只取第一次有效模型评分 |
| 既有跨轮唯一通过 | 60 | 67.4% | 含原先两道 pass@2 题 |
| 当前跨轮唯一通过 | **75** | **84.3%** | 至少一个已完成 verifier 给出 reward=1 |
| 相对既有跨轮结果新增 | **15** | **+16.9 个百分点** | 同题跨多轮只计一次 |

该 84.3% 汇总多轮模型与环境结果，不能作为单轮 Pass@1，也不能直接与公开排行榜比较。新增的 15 道题如下：

| 来源 | 新增通过题目 | 本轮结果 |
| --- | --- | ---: |
| `biny-dsv41-tb21-infra-replacements-20260925-v3-concurrent2` | `gpt2-codegolf`、`qemu-alpine-ssh` | 新增 2；`largest-eigenval` 的 reward=1 已在旧累计中 |
| `biny-dsv41-failure-rerun-27-conc3-20260926` | `bn-fit-modify`、`break-filter-js-from-html`、`compile-compcert`、`dna-assembly`、`fix-ocaml-gc`、`hf-model-inference`、`llm-inference-batching-scheduler`、`mteb-leaderboard`、`pypi-server`、`qemu-startup`、`torch-pipeline-parallelism`、`winning-avg-corewars` | 12/27 reward=1；15/27 reward=0；无 trial 异常 |
| `biny-dsv41-max-reasoning-failure-rerun-13-conc3-20260927` | `dna-insert` | 1/13 reward=1；12/13 reward=0；无 trial 异常 |

服务生命周期类 badcase 中，`hf-model-inference`、`pypi-server`、`qemu-startup` 在 27 题重跑中由旧 reward=0 变为 reward=1，即目标类别 **3/4** 通过；`kv-store-grpc` 仍为 0，verifier Python 环境缺少 `grpc`。这 3/4 是本次运行中与生命周期修复直接相关的实测结果；不能把全部 15 道新增通过都归因于代码，因为普通重跑还包含模型采样和基础设施波动。

MAX reasoning 轮与普通 reasoning 轮的 Biny 包 SHA256（`5ea232c0…`）和源码指纹（`d6b99494…`）相同，改变的是 reasoning 配置。因此 `dna-insert` 的 1/13 结果单独记录为配置实验，不计作代码提交带来的确定性提升。

`gpt2-codegolf` 和 `qemu-alpine-ssh` 的 verifier reward 都是 1，但 Agent 达到超时；这里按 verifier 已确认产物通过计入跨轮 union，同时保留超时事实。`fix-ocaml-gc` 的本轮 verifier 40/40 通过；`sam-cell-seg` 仍为 0，测试因缺少 `libGL.so.1` 在收集阶段失败。

## 原始 Pass@1 结果明细（截至 2026-09-24）

| 结论 | 数量 | 占比 | 定义 |
| --- | ---: | ---: | --- |
| ✅ 通过 | 58 | 65.2% | 第一次模型评分即为 1（含基建替换） |
| ❌ 判 0 | 30 | 33.7% | verifier 跑完测试并断言未过 |
| ⚠️ 判 0（判分器 setup 失败） | 1 | 1.1% | 测试从未运行，**非模型信号** |
| 合计 | 89 | 100% | |

## 诊断分解

| 诊断 | 值 | 说明 |
| --- | ---: | --- |
| 条件通过率（排除判分器 setup 失败） | 58/88 = 65.9% | |
| pass@2 增益 | +2 道 | 首评判 0 后重跑通过，**不纳入 pass@1** |
| 判分器 setup 失败率 | 1/89 = 1.1% | 题目 test.sh 需现场 apt 装依赖 |

## 可比性声明（重要）

1. **pass@1 的定义**：每格取**第一次**拿到 verifier reward 的结果。基建报废的格子允许被替换一次，替换结果计入 —— 与 Maka 的 `one allowed replacement admission` 一致。
2. **已剥离 pass@N**：`configure-git-webserver`, `git-multibranch` 两道首评是真判 0（verifier 跑完、断言没过），后因补跑规则不严谨被重跑并通过，**不计入 pass@1**。
3. **`train-fasttext` 的 0 不构成模型证据**：判分器启动后 `apt-get install` 撞 24 次 `502 Bad Gateway`，导致 `git`/`curl`/`/opt/fastText` 缺失，`tests/test.sh` 一行没跑就退出。
   **GLM 基线同一道题完全相同**（21 次 apt 失败、pytest 会话 0 次、同样的 `Python downloads are set to 'never'` 提示）。
   两边同病，故按 0 计入以保持一致；但它不代表任何一方的能力差异。
4. **agent 时限两边曾经不同尺**：基线用 harbor 默认倍数 1（= 1 小时），本次批量跑用倍数 4（= 4 小时，实际被 adapter 的 2 小时 exec 上限截断）。
   方向上对本次有利，已如实标注。`train-fasttext` 的重测已改用倍数 1 对齐。
5. **verifier 现场联网**是本题集的系统性风险：`tests/test.sh` 普遍要 apt/uv 下载，而本机链路（见下节）单次失败率约 20%。

## 运行配置

| 项 | 值 |
| --- | --- |
| 模型 | `deepseek/deepseek-v4.1-flash` |
| Provider | `commandcode`（`https://api.commandcode.ai/provider/v1`，chat_completions） |
| Agent | biny headless CLI（`scripts/evals/harbor/biny_agent.py`） |
| 任务集 | Terminal-Bench 2.1，89 题 |
| 并发 | 3 → 4 |
| agent exec 上限 | 7200s |
| provider 重试 | maxAttempts 6（biny schema 上限） |
| 工具调用上限 | 不设（biny 默认 512） |
| 判分工具链 | 预置 uv 0.9.5 / uvx / pytest 8.4.1 + `--verifier-env` |

## 这份报告真正的内容：九处基建问题

**初始一次干净跑只有 41/89 (46.1%)，最终 58/89 (65.2%)。差额全部来自修复评测基建，不是模型变强。**

| # | 问题 | 表现 | 影响 |
| ---: | --- | --- | --- |
| 1 | setup 的 `npm install` 零重试 | `npm error network` | 2 道报废 |
| 2 | 没有 runtime 缓存 | 每个容器重装依赖 | 放大 #1 |
| 3 | node 版本判断只看「命令存在」 | 镜像自带 Node 18 → `node:sqlite` 缺失 | 1 道 |
| 4 | 未预置 verifier 工具链 | `uvx: command not found` → 判 0 | 影响 82 道 |
| 5 | `verifier-env.sh` 从未接线 | `UV_PYTHON_DOWNLOADS` 缺失 | 同 #4 |
| 6 | `maxToolCalls: 128` | `reached its 128-call limit` | 3 道 |
| 7 | exec 上限 1800s | `Command timed out after 1800 seconds` | 18 道 |
| 8 | instruction 未加 `--` | 以 `- ` 开头的题被当选项 | 1 道 |
| 9 | `retry.maxAttempts` 4 | TLS 抖动 → 连续 4 次全挂 | 10 道 |

另有三条**方法论**漏径：真判 0 被重跑（pass@N）、单轮分类误判基建、一次 schema 上限越界；
以及一处**计时器错配**：adapter 的 exec 上限低于 harbor 的 agent 预算时，「超时」被翻译成「崩溃」，
**verifier 被整段跳过**（`train-fasttext` 连续 8 轮因此没有评分）。

## 环境网络实测

容器到 provider 的链路经宿主代理，实测单次请求失败率约 **20%**（探针 41 分钟 / 55 笔）：

| 端点 | 成功率 |
| --- | ---: |
| `api.commandcode.ai`（经代理） | 83.2% |
| `api.z.ai`（经代理，对照） | 69.5% |
| `api.deepseek.com`（直连，对照） | 100.0% |

**不是 provider 的问题，是过代理那条路的稳态劣化。** 同一现象也表现在判分阶段（apt 502）。

## 数据缺口

- **无 token / 成本数据**：harbor 的 `n_input_tokens` / `cost_usd` 全为 null，故本报告不含经济性分析。

## 原始逐题结果（截至 2026-09-24）

| 题目 | 结论 | 说明 | 各轮评分 |
| --- | --- | --- | --- |
| `adaptive-rejection-sampler` | 通过 | 首评即通过 | 1 |
| `bn-fit-modify` | 判 0 | 首评即判 0 | 0 |
| `break-filter-js-from-html` | 判 0 | 首评即判 0 | 0 → 0 |
| `build-cython-ext` | 判 0 | 首评即判 0 | 0 |
| `build-pmars` | 通过 | 首评即通过 | 1 |
| `build-pov-ray` | 通过 | 首评即通过 | 1 |
| `caffe-cifar-10` | 通过 | 首评即通过 | 1 |
| `cancel-async-tasks` | 通过 | 首评即通过 | 1 |
| `chess-best-move` | 通过 | 首评即通过 | 1 |
| `circuit-fibsqrt` | 通过 | 首评即通过 | 1 |
| `cobol-modernization` | 通过 | 首评即通过 | 1 |
| `code-from-image` | 通过 | 首评即通过 | 1 |
| `compile-compcert` | 判 0 | 首评即判 0 | 0 |
| `configure-git-webserver` | 通过(pass@N) | 首评判0，重跑才过 | 0 → 1 |
| `constraints-scheduling` | 通过 | 首评即通过 | 1 |
| `count-dataset-tokens` | 通过 | 首评即通过 | 1 |
| `crack-7z-hash` | 通过 | 首评即通过 | 1 |
| `custom-memory-heap-crash` | 通过 | 首评即通过 | 1 |
| `db-wal-recovery` | 通过 | 首评即通过 | 1 |
| `distribution-search` | 通过 | 首评即通过 | 1 |
| `dna-assembly` | 判 0 | 首评即判 0 | 0 |
| `dna-insert` | 判 0 | 首评即判 0 | 0 → 0 |
| `extract-elf` | 通过 | 首评即通过 | 1 |
| `extract-moves-from-video` | 判 0 | 首评即判 0 | 0 |
| `feal-differential-cryptanalysis` | 判 0 | 首评即判 0 | 0 → 0 |
| `feal-linear-cryptanalysis` | 通过 | 首评即通过 | 1 |
| `filter-js-from-html` | 判 0 | 首评即判 0 | 0 → 0 |
| `financial-document-processor` | 通过 | 首评即通过 | 1 |
| `fix-code-vulnerability` | 通过 | 首评即通过 | 1 |
| `fix-git` | 通过 | 首评即通过 | 1 |
| `fix-ocaml-gc` | 判 0 | 首评即判 0 | 0 |
| `gcode-to-text` | 判 0 | 首评即判 0 | 0 |
| `git-leak-recovery` | 通过 | 首评即通过 | 1 |
| `git-multibranch` | 通过(pass@N) | 首评判0，重跑才过 | 0 → 1 |
| `gpt2-codegolf` | 判 0 | 首评即判 0 | 0 |
| `headless-terminal` | 通过 | 首评即通过 | 1 |
| `hf-model-inference` | 判 0 | 首评即判 0 | 0 → 0 |
| `install-windows-3.11` | 通过 | 首评即通过 | 1 |
| `kv-store-grpc` | 判 0 | 首评即判 0 | 0 → 0 |
| `large-scale-text-editing` | 通过 | 首评即通过 | 1 |
| `largest-eigenval` | 通过 | 首评即通过 | 1 |
| `llm-inference-batching-scheduler` | 判 0 | 首评即判 0 | 0 |
| `log-summary-date-ranges` | 通过 | 首评即通过 | 1 |
| `mailman` | 通过 | 首评即通过 | 1 |
| `make-doom-for-mips` | 判 0 | 首评即判 0 | 0 |
| `make-mips-interpreter` | 判 0 | 首评即判 0 | 0 |
| `mcmc-sampling-stan` | 通过 | 首评即通过 | 1 |
| `merge-diff-arc-agi-task` | 通过 | 首评即通过 | 1 |
| `model-extraction-relu-logits` | 通过 | 首评即通过 | 1 |
| `modernize-scientific-stack` | 通过 | 首评即通过 | 1 |
| `mteb-leaderboard` | 判 0 | 首评即判 0 | 0 |
| `mteb-retrieve` | 判 0 | 首评即判 0 | 0 → 0 |
| `multi-source-data-merger` | 通过 | 首评即通过 | 1 |
| `nginx-request-logging` | 通过 | 首评即通过 | 1 |
| `openssl-selfsigned-cert` | 通过 | 首评即通过 | 1 |
| `overfull-hbox` | 通过 | 首评即通过 | 1 |
| `password-recovery` | 通过 | 首评即通过 | 1 |
| `path-tracing` | 通过 | 首评即通过 | 1 |
| `path-tracing-reverse` | 通过 | 首评即通过 | 1 |
| `polyglot-c-py` | 通过 | 首评即通过 | 1 |
| `polyglot-rust-c` | 通过 | 首评即通过 | 1 |
| `portfolio-optimization` | 通过 | 首评即通过 | 1 |
| `protein-assembly` | 通过 | 首评即通过 | 1 |
| `prove-plus-comm` | 通过 | 首评即通过 | 1 |
| `pypi-server` | 判 0 | 首评即判 0 | 0 → 0 |
| `pytorch-model-cli` | 判 0 | 首评即判 0 | 0 |
| `pytorch-model-recovery` | 通过 | 首评即通过 | 1 |
| `qemu-alpine-ssh` | 判 0 | 首评即判 0 | 0 |
| `qemu-startup` | 判 0 | 首评即判 0 | 0 → 0 |
| `query-optimize` | 通过 | 首评即通过 | 1 |
| `raman-fitting` | 通过 | 首评即通过 | 1 |
| `regex-chess` | 通过 | 首评即通过 | 1 |
| `regex-log` | 通过 | 首评即通过 | 1 |
| `reshard-c4-data` | 通过 | 首评即通过 | 1 |
| `rstan-to-pystan` | 通过 | 首评即通过 | 1 |
| `sam-cell-seg` | 判 0 | 首评即判 0 | 0 |
| `sanitize-git-repo` | 通过 | 首评即通过 | 1 |
| `schemelike-metacircular-eval` | 通过 | 首评即通过 | 1 |
| `sparql-university` | 通过 | 首评即通过 | 1 |
| `sqlite-db-truncate` | 通过 | 首评即通过 | 1 |
| `sqlite-with-gcov` | 通过 | 首评即通过 | 1 |
| `torch-pipeline-parallelism` | 判 0 | 首评即判 0 | 0 → 0 |
| `torch-tensor-parallelism` | 通过 | 首评即通过 | 1 |
| `train-fasttext` | 判 0* | 判分器 setup 失败（apt 502），测试从未运行 | 0 |
| `tune-mjcf` | 判 0 | 首评即判 0 | 0 |
| `video-processing` | 判 0 | 首评即判 0 | 0 → 0 |
| `vulnerable-secret` | 通过 | 首评即通过 | 1 |
| `winning-avg-corewars` | 判 0 | 首评即判 0 | 0 |
| `write-compressor` | 通过 | 首评即通过 | 1 |
