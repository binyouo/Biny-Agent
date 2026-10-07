# 目标与自动化

Biny 用不同对象表达持续目标、依赖任务和定时触发。会话目标控制跨回合推进，Graph 描述节点依赖，TaskRun 记录实际尝试与验证，Automation 决定何时发起运行。

## 定义如何变成一次运行

| 对象 | 保存什么、决定什么 |
| --- | --- |
| Session Goal | 会话的持续目标、状态与用量预算，决定是否继续后续回合。 |
| TaskRun / Attempt | 稳定任务身份及各次尝试、阻塞和验证结果。 |
| Graph | 节点与依赖，决定哪些任务满足启动条件。 |
| Automation | 触发类型、时间配置、提示词和生命周期限制。 |
| Fire | 一次具体到期触发，保存计划时间、领取状态、真实 run 绑定及错误。 |

AutomationScheduler 检查到期定义，持久化 Fire，通过唯一 claim 领取后交给 Host 准入入口创建真实 Agent run。定时器只负责唤醒检查，触发是否执行以持久 Fire 和 run 记录为准。目标会话忙碌时可延期，需授权时保留待批准状态；定义存在、已经到期和真实运行完成各有独立结果。

持续目标由 SessionGoalRunner 在允许的会话状态下推进后续回合。任务尝试与 Graph 调度使用各自的持久状态，后续成功不会覆盖此前失败。Host 重启后根据运行绑定和已有结果恢复判断，而不是从内存计时器推断是否执行过。

## 会话目标

目标必须绑定具体会话。先从 `biny sessions --json` 获取当前项目的会话 ID，再设置完整目标：

```bash
biny goal set "完成模块修复，并提供测试与结果说明" --session <session-id> --json
biny goal show --session <session-id> --json
biny goal pause --session <session-id> --json
biny goal resume --session <session-id> --json
biny goal clear --session <session-id> --json
```

`set` 可加 `--token-budget <tokens>` 设置预算；省略时不额外设置该预算。目标保存后，Host 在允许的状态下继续发起后续回合。普通聊天不会自动变成持续目标。

Desktop 输入框上方的目标栏提供查看、编辑、暂停、继续和删除。编辑正文改变后续执行目标，不能改写已经发生的工具操作。

预算按实际请求回执收敛。它限制后续请求，不能精确截断已经发出的模型 token；服务商未返回的用量保持未知。暂停与清除阻止后续目标推进，不撤销已发生的外部动作。

模型将目标标为完成是语义判断。需要确定性验收的任务仍须检查文件、测试或 verifier 证据。

## TaskRun 与依赖图

```bash
biny task create "检查模块并给出修复建议" --session <session-id> --json
biny task run <task-run-id> --json
biny task get <task-run-id> --json
biny task events <task-run-id> --json
```

创建记录不表示已经执行。TaskRun 保持稳定任务身份，每次实际尝试保存独立 Attempt；历史失败不被新尝试覆盖。需要验证的任务可通过 `--verification` 提供支持的验收契约，参数见 `biny task create --help`。

`task get` 查询不存在的 ID 时，在标准错误输出说明原因并以状态码 `1` 退出，标准输出为空；使用 `--json` 时也遵循此错误规则。

Graph 关联多个任务及依赖。可用 `biny graph list --json`、`biny graph inspect <graph-id> --json` 查看，再通过 `start`、`pause`、`resume` 和 `cancel` 控制。Graph 管依赖，不能替代会话目标；当前 `goal` 命令只管理会话目标。

## 定时执行

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

可用触发类型：

| 类型 | 配置 |
| --- | --- |
| `interval` | `--interval-ms`，按间隔触发。 |
| `heartbeat` | `--interval-ms`，可用 `--session` 绑定会话。 |
| `cron` | `--cron`，五字段 cron 表达式。 |
| `once` | `--at`，ISO 时间戳；省略时按创建时刻安排。 |

cron 按运行进程的本地时区计算；跨时区部署时检查机器时区。`--max-fires` 和 `--expires-at` 可约束定义的生命周期。

计划时间与待触发时间都按实际时刻判断到期和排序，时间戳使用不同时区偏移时也遵循这一规则。此前漏掉的到期记录可能重新成为执行候选，仍须通过次数上限、过期和执行准入检查。非法的持久化时间会使所属定义暂停并保存错误原因。

```bash
biny automation pause <automation-id> --json
biny automation resume <automation-id> --json
biny automation run <automation-id> --json
biny automation delete <automation-id> --json
```

没有目标会话的普通定时任务使用独立会话；Heartbeat 复用所选或当前主会话。定义、一次到期触发和真实 Agent run 有独立状态，列表存在不表示已经执行。

## 本机驻留与失败

调度器在本机 Runtime Host 中运行。机器关机、睡眠或 Host 未运行时不能持续执行。macOS 可用 `biny daemon install` 安装用户 LaunchAgent，使用 `biny daemon status` 查看，`biny daemon uninstall` 卸载；安装是显式的本机配置操作。

目标会话忙碌或 Host 达到并发限额时，触发可延期并保存原因。连续失败可使定义暂停；排查真实 run、fire 与任务状态，不只看 cron 是否设置正确。

进程重启后会检查已有运行绑定和持久证据。已完成结果不重复提交；派发后结果未知的写操作不自动重放。`task resume` 与 `task retry` 含义不同，先读取当前阻塞原因；需要批准的验证使用返回的准确 approval ID。

权限范围见 [工具与权限](PERMISSIONS.md)，会话与中断处理见 [会话与恢复](SESSIONS.md)。
