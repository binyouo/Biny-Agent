# 目标与自动化

Biny 通过分层对象表达持续目标、任务依赖与定时触发：
- **Session Goal（会话目标）**：控制跨轮次的自主推进与用量预算。
- **TaskRun / Attempt（任务尝试）**：维护稳定任务身份与各次执行、验证结果。
- **Graph（任务依赖图）**：描述任务间的拓扑依赖与前置条件。
- **Automation / Fire（定时自动化）**：定义定时触发规则（Cron / 间隔）与具体触发记录。

## 核心对象模型

| 对象类型 | 保存内容与实际职责 |
| --- | --- |
| **Session Goal** | 绑定具体会话，维护持续目标、执行状态与 Token 预算，控制自动开启后续回合。 |
| **TaskRun / Attempt** | 记录稳定的任务身份，每次真实执行记为独立的 Attempt，保留历史阻断与验证证据。 |
| **Graph** | 拓扑依赖图，计算前置节点状态并决定下游任务何时满足启动条件。 |
| **Automation** | 自动化规则定义：触发器类型（Cron / 间隔 / 一次性）、Prompt 与生命周期限制。 |
| **Fire** | 具体某次到期生成的执行凭据，记录计划时间、领取状态、绑定的真实 Run 及执行错误。 |

### 调度与持久化机制

- **解耦触发**：`AutomationScheduler` 负责扫描到期规则，为到期事件持久化一条 `Fire` 记录，由 Host 通过原子锁领取后创建真实 Agent 运行。计时器仅负责唤醒，实际执行以数据库中的 `Fire` 与 `Run` 状态为准。
- **忙碌延期**：若目标会话当前正处于执行状态，触发会自动延期，等待会话空闲后再调度。
- **重启恢复**：系统重启后，根据持久化的 `Fire` 与 `Run` 绑定恢复现场，避免重复派发已完成的任务。

## 会话目标（Session Goal）

会话目标用于指导 Agent 跨轮次自主执行复杂任务直至达成目标。

```bash
biny goal set "完成模块重构，并补充测试与结果说明" --session <session-id> --token-budget 50000 --json
biny goal show --session <session-id> --json
biny goal pause --session <session-id> --json
biny goal resume --session <session-id> --json
biny goal clear --session <session-id> --json
```

### 控制与保护规则

- **会话绑定**：目标必须绑定具体会话（通过 `biny sessions --json` 获取 ID）。普通聊天默认不开启持续目标。
- **预算控制（`--token-budget`）**：按模型请求实际回执累计消耗；达到预算后停止发起新轮次，已发出的模型调用按服务商实际计费结算。
- **死循环与重复探测保护**：若连续 3 个自动回合重复相同的失败调用或只读文件查询且得到相同结果，系统会自动暂停目标，防止无效消耗。用户提交新输入或排除故障后，执行 `biny goal resume` 即可继续。
- **交互控制**：
  * **Desktop 桌面端**：输入框上方显示目标栏，支持实时编辑目标、暂停、继续与清除。
  * **终端 TUI**：状态行同步显示 Goal 状态与目标摘要；输入 `/goal <目标>`、`/goal pause`、`/goal resume`、`/goal clear` 直接控制。
- **完成判定**：模型宣告完成属于语义判断；关键交付仍建议结合确定性测试或命令验收。

## TaskRun 与依赖图（Graph）

```bash
biny task create "检查入口模块并给出修复建议" --session <session-id> --json
biny task run <task-run-id> --json
biny task get <task-run-id> --json
biny task events <task-run-id> --json
```

- **任务与尝试分离**：创建记录不等于开始执行。每次实际调用生成独立的 Attempt 记录，历史失败不会被新尝试抹除，完整保留排查轨迹。
- **契约验收**：通过 `--verification` 可挂载验收命令与产物核对契约。
- **拓扑依赖图（Graph）**：通过 `biny graph list` 与 `biny graph inspect <graph-id>` 管理多任务拓扑，通过 `start` / `pause` / `resume` / `cancel` 控制任务流转。

## 定时自动化（Automation）

```bash
biny automation create hourly-review \
  --trigger interval \
  --interval-ms 3600000 \
  --prompt "检查项目待办并报告需要处理的变化" \
  --max-fires 8 \
  --json
biny automation list --json
biny automation pending --json
```

### 支持的触发器类型

| 触发器类型 | 参数配置 | 说明 |
| --- | --- | --- |
| `interval` | `--interval-ms <毫秒>` | 固定间隔周期触发。 |
| `heartbeat` | `--interval-ms <毫秒>` | 周期性心跳巡检，支持通过 `--session` 绑定专属会话。 |
| `cron` | `--cron "<表达式>"` | 标准五、六或七字段 Cron，支持 `--timezone` 指定时区。 |
| `once` | `--at "<ISO时间戳>"` | 一次性定时执行（省略时按创建时刻调度）。 |

### 触发与时区规则

- **Cron 语法与时区**：未指定 `--timezone` 时，自动固化当前机器的 IANA 时区（如 `Asia/Shanghai`）。支持秒、年、`L`、`W`、`#` 语法；日与星期同时指定时按 OR 匹配。后续机器时区发生变更不会破坏已有 Cron 的本地执行时刻。
- **漏跑策略（Catch-up）**：
  * 周期性任务（`interval` / `cron` / `heartbeat`）：若机器关机或休眠导致错过多个周期，唤醒后**仅触发最近的一次**，下一个周期重新向后推算，不盲目补跑历史积压。
  * 一次性任务（`once`）：即使延期发现，依然会保留并执行一次。
- **单次运行限制**：无指定目标会话的通用自动化在独立临时会话中运行，单次最长执行 8 分钟，超时后安全中止；绑定具体会话的任务不设此限。

常用控制命令：

```bash
biny automation pause <automation-id> --json
biny automation resume <automation-id> --json
biny automation run <automation-id> --json
biny automation delete <automation-id> --json
```

## 本机驻留与守护进程

调度器依托本机 Runtime Host 运行；机器关机或休眠时无法执行调度。

- **macOS 后台守护进程**：支持将 Host 注册为用户级 LaunchAgent，实现后台开机自启：
  ```bash
  biny daemon install   # 安装 LaunchAgent
  biny daemon status    # 查看守护状态
  biny daemon uninstall # 卸载 LaunchAgent
  ```
- **故障排查**：连续执行失败时规则会自动暂停以保护系统。排查时可同时核对 `automation`、`fire` 与 `task` 记录，查看具体错误堆栈。

权限机制见 [工具与权限](PERMISSIONS.md)，会话恢复见 [会话与恢复](SESSIONS.md)。
