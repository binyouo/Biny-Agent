# 工具与权限

Biny 对模型提出的工具调用检查操作、目标、风险与当前授权。文件和命令权限、macOS 系统权限、桌面应用授权分别管理；一个入口获准不能自动证明其他入口获准。

## 通用权限模式

全局配置的 `permission.mode` 支持：

| 模式 | 行为 |
| --- | --- |
| `read-only` | 拒绝非读取操作。 |
| `ask` | 根据显式规则、会话授权与低风险读取判断，其余请求询问。 |
| `auto` | 在已有规则之外，自动允许低风险操作；其余请求询问。 |
| `full-access` | 跳过通用交互审批，仍执行显式拒绝路径检查。 |

当前默认模式是 `full-access`。`ask` 不表示每一次读取都弹出确认，`auto` 也不表示所有操作都自动允许。

下面是合入全局配置的示例片段：

```json
{
  "permission": {
    "mode": "ask",
    "allowTools": ["Read", "Glob", "Grep"],
    "allowPaths": [],
    "denyPaths": [".env", ".ssh/"],
    "criticalAlwaysAsk": true
  }
}
```

在 `ask` 与 `auto` 中，关键风险操作会按 `criticalAlwaysAsk` 请求确认；`full-access` 已明确跳过这层交互审批。

一次性任务可以临时覆盖模式：

```bash
biny run "检查项目结构" --permission-mode read-only --json
```

## 一次批准覆盖什么

批准针对实际工具、路径或命令及其参数。临时会话授权只在相应范围内生效；它不扩大工具预算、不改变系统权限，也不让后续不同目标自动通过。

文件写入在批准后继续核对目标路径和文件状态。拒绝路径优先于一般允许规则；软链或目标变化不能用旧批准绕过检查。

## 文件枚举与搜索的完整性

`Glob` 与 `Grep` 保留可读取的结果；扫描时无法读取或已经消失的目录记录在 `unreadableDirectories`，路径相对于工作区，`.` 表示工作区根目录。`Grep` 另外用 `unreadableFiles` 标记读取失败的文件，用 `fileLimitReached` 标记候选文件超过扫描上限。

`hasMore` 只表示发现的结果还有下一页。即使它为 `false`，上述跳过或上限提示仍表示结果不完整，不能据此认定工作区中没有其他匹配。恢复目录访问后应从第一页重新扫描；原有游标不会补回先前跳过的内容。主动忽略的路径及与指定 `path` 无关的目录不列入跳过提示；无法读取的祖先目录仍会报告。

解析新 `Grep` 输出的调用方应使用 `unreadableFiles`；不再提供 `skippedFiles` 字段或别名。已保存的会话和归档不会改写，旧归档的预览或 `read_tool_result` 返回文本仍可能因敏感文本过滤而丢失旧字段名称。需要完整的具名警告时，应重新搜索生成新结果。

## 沙箱与审批

`sandbox.mode` 可选择 `off` 或 `workspace-write`，`sandbox.allowNetwork` 控制所配置沙箱中的网络策略。当前缺省为 `off`、`allowNetwork: true`。

权限模式决定是否准入，沙箱约束实际命令执行。启用其中一项不表示另一项已经开启；也不能把插件的进程内代码加载描述成命令沙箱的一部分。

## 桌面应用

Computer Use 另外要求系统能力与产品开关。严格应用审批开启后，只允许已批准的应用，通用工具的自动允许和 `full-access` 不覆盖这个条件。

首次发现、批准与撤销记录保存在全局配置。关闭产品入口或撤销应用授权影响后续控制；已经派发给系统的输入不能撤回。具体操作见 [Computer Use](COMPUTER_USE.md)。

## 用户直接执行的 CLI

本机用户执行命令与模型工具审批不同。`biny cu` 是直接原生入口，不经过产品应用审批和观察凭据校验；`biny browser` 的直接命令也不经过模型工具审批。它们仍受各自系统、连接和文件边界约束。

Agent 使用这些 CLI 时仍须遵守用户授予的任务范围，不能改用命令绕过被拒绝的模型工具操作。

## 外部内容与未知结果

网页、工具返回、MCP 说明和 Skill 文本都是内容来源，不授予新的操作权限。读取页面不等于获准发送消息，连接服务不等于获准支付或删除资料。

取消、超时或断线后，已派发的操作可能已经发生。状态无法确认时保留未知结果，检查实际目标后再决定恢复；重新连接不能充当写操作重试。

实现入口：[PermissionManager](../src/permission/PermissionManager.ts)、[工具执行协调](../src/agent/toolExecutionCoordinator.ts)。配置与凭据见 [模型与配置](CONFIGURATION.md)，外部扩展见 [MCP、Skills 与插件](EXTENSIONS.md)。
