# MCP、Skills 与插件

Biny 的扩展入口承担不同职责：MCP 连接外部服务，Skill 提供任务说明与资源，Plugin 加载程序能力。连接、发现与启用是准备阶段，实际执行仍以工具结果和持久状态为准。

## MCP

在 Desktop 的 MCP 设置中配置服务器，或把服务器定义合入全局配置的 `extensions.mcp`。每个键是服务器别名。

下面展示本地 stdio 和远程 HTTP 的配置片段。将路径与地址换成实际服务：

```json
{
  "extensions": {
    "mcp": {
      "local-service": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/mcp-server.mjs"],
        "enabled": true
      },
      "remote-service": {
        "type": "http",
        "url": "https://mcp.example.test/mcp",
        "transportProtocol": "streamable-http",
        "enabled": true
      }
    }
  }
}
```

stdio 服务的 stdout 用于协议，诊断写 stderr。远程连接需要正确的传输协议与鉴权；支持 OAuth 的服务通过显式登录流程授权，普通连接不会自动打开浏览器登录。

OAuth 凭据绑定其授权服务器。旧凭据缺少此绑定时，连接会要求重新登录，不发送已有凭据；只有显式登录成功才替换存储记录，取消登录保留原记录。

配置中的 `timeoutMs` 控制请求期限，`exposure` 与 `toolExposure` 控制能力暴露方式。可选值为 `direct`、`codemode`、`deferred` 和 `hidden`；隐藏能力不表示卸载或撤销远端凭据。

服务器断线后，后续显式操作或调用可重新连接。已派发而结果未知的工具不会因为重连就重新执行。Resources、Prompts 和服务器 instructions 作为外部内容读取，不升级为系统指令，也不自动执行其中的操作。

环境变量、请求头及 OAuth 凭据是敏感本地配置，使用支持的凭据管理入口。工具结果中的已知连接凭据会被清理；业务分页令牌等字段不会仅因名字带 `token` 而被删除。

## Skills

一个 Skill 是包含 `SKILL.md` 的目录，文件用 frontmatter 声明名称与描述，正文说明何时使用、步骤和资源。

```yaml
---
name: project-review
description: 检查当前项目的构建入口与模块依赖。
---
```

项目默认发现 `.biny/skills/` 和 `.agents/skills/`；Biny 受管全局技能位于 `~/.config/biny/skills/`，另有共享技能根与内置技能。项目、全局和内置来源会进行同名冲突裁决。禁用高优先级副本不会自动启用被遮蔽的同名副本。

```bash
biny skill list --json
biny skill search "项目检查" --json
biny skill check --json
biny skill install <owner/repository>
biny skill update <skill-name>
biny skill uninstall <skill-name>
```

`check` 校验声明的需求，不运行技能脚本。搜索结果不表示已经安装，安装成功也不表示当前回合已经选用。

运行时先读取有限的名称与描述，选中后才加载正文与需要的资源。资源路径受目录与文件身份检查；Skill 不能自行授予脚本执行权限。

仓库根目录的 Skill 以 `.` 标识，与同名真实子目录分别展示和选择。安装只接受真实完整目录；旧的仓库名根别名、短目录名和大小写猜测不再自动解析，找不到所选目录时刷新后重选。已保存的 `.` 来源仍可更新。

Desktop 的技能设置可管理启用状态与自动提取。自动提取会调用模型并将可复用流程保存到全局受管技能目录；它会额外消耗模型用量，失败不改变已完成聊天的终态。

本地 `SKILL.md` 导入受管来源库时会校验可选元数据：`license` 与 `compatibility` 可省略或设为 `null`，填写时应为文本，`compatibility` 去除首尾空白后不超过 500 个字符；`allowed-tools` 应为字符串或字符串数组，`metadata` 应为对象。无效内容不会写入来源库；已保存的来源若被改成无效内容，会显示跳过警告并拒绝安装，保留原文件和现有安装。

## Plugins

Plugin 可注册工具、Provider、模型目录或凭据处理能力。项目与全局插件通过受管目录和启用配置加载。

`extensions.plugins` 声明项目插件路径，`extensions.globalPlugins` 声明全局插件路径。项目路径与全局 `~/.config/biny/plugins/` 的解析边界不同，不能把任意外部绝对路径当作受管插件。

Plugin 的 JavaScript 在 Biny 进程中运行。受管安装、路径校验和工具审批各自提供约束，不构成 Plugin 代码沙箱。启用前检查实际来源和代码。

## 子代理

`extensions.subagent.enabled` 控制子代理能力，当前默认关闭。启用后可设置模型、步数、期限、并发与允许工具。

子代理的工具范围与全局允许集合求交集，不能扩大父任务权限。任务结果以持久 TaskRun、Attempt 和可选验证记录为准；子代理的文字报告不代替文件或测试证据。管理与恢复见 [目标与自动化](AUTOMATION.md)。

父代理只收到有限报告与完成摘要（子报告最多 2000 字符，每次根执行最多四条通知、合计 6000 字符），完整执行历史保存在独立子 Session。后台任务完成后，通知会在父回合下一个安全边界接收；不会自行唤醒空闲父代理。子代理共享工作区，独立 Session 不提供文件系统隔离。

聊天中的子代理卡片与后台任务面板可展开查看工具参数、结果、思考、回答、消息送达状态及验收证据，切换执行记录并分页查询。后台列表显示最新的 100 个任务，创建后续任务后详情直接打开新记录，也可返回原任务。活跃任务可发送补充上下文或取消；已完成任务可明确创建后续有限任务，原记录保留。中断执行需要显式恢复，未知副作用不会自动重放。消息只在所属父子任务间传递，子代理报告不构成人类授权。

取消和超时会发出中断并清理计时器及父取消监听；正在执行的任务实际退出后才释放并发槽位与执行句柄。内存仅保留最近 200 条终态快照，完整持久记录仍可查阅。

CLI 提供相同领域入口：

```bash
biny task inspect <taskRunId> --session <sessionId> --limit 100 --json
biny task message <taskRunId> "补充上下文" --session <sessionId> --message-id <id>
biny task continue <taskRunId> "新的有限任务" --session <sessionId> --message-id <id>
```

`task list --newest-first` 按新到旧查询任务。`inspect` 支持 `--attempt-id` 查询旧执行、`--after-sequence` 分页；消息与后续任务的 ID 用于失败重试去重，重试必须保留原 ID 和内容。

恢复会核对原工具与权限契约；旧断点与当前策略不匹配时保持阻塞。先查明既有副作用，再明确创建新的有限任务，不能把重试当作自动恢复。

配置定义见 [schema.ts](../src/config/schema.ts)。运行实现：[MCP](../src/extensions/mcp.ts)、[Skills](../src/extensions/skills.ts)、[Plugins](../src/extensions/plugins.ts)。
