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

## Plugins

Plugin 可注册工具、Provider、模型目录或凭据处理能力。项目与全局插件通过受管目录和启用配置加载。

`extensions.plugins` 声明项目插件路径，`extensions.globalPlugins` 声明全局插件路径。项目路径与全局 `~/.config/biny/plugins/` 的解析边界不同，不能把任意外部绝对路径当作受管插件。

Plugin 的 JavaScript 在 Biny 进程中运行。受管安装、路径校验和工具审批各自提供约束，不构成 Plugin 代码沙箱。启用前检查实际来源和代码。

## 子代理

`extensions.subagent.enabled` 控制子代理能力，当前默认关闭。启用后可设置模型、步数、期限、并发与允许工具。

子代理的工具范围与全局允许集合求交集，不能扩大父任务权限。任务结果以持久 TaskRun、Attempt 和可选验证记录为准；子代理的文字报告不代替文件或测试证据。管理与恢复见 [目标与自动化](AUTOMATION.md)。

配置定义见 [schema.ts](../src/config/schema.ts)。运行实现：[MCP](../src/extensions/mcp.ts)、[Skills](../src/extensions/skills.ts)、[Plugins](../src/extensions/plugins.ts)。
