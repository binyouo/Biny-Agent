<h1 align="center">Biny</h1>

<p align="center">本地优先的开发协作 Agent，提供 macOS Desktop、TUI 与 CLI。</p>

<p align="center">
  <a href="https://github.com/JubinJean/Biny-Agent">GitHub</a> ·
  <a href="#about">About</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#development">Development</a>
</p>

> 🚧 This project is under active development. APIs, commands, and behavior may change as the implementation evolves.

## About

Biny 是面向本地开发工作的 Agent。它在同一套会话中提供对话、任务执行和项目上下文处理，并支持从中断处继续工作。

主要能力：

- Desktop、TUI 与 CLI 共用会话和配置。
- 本地记忆与活动记录帮助延续跨会话工作。
- 可通过 MCP、Plugin 和 Skill 扩展能力。

## Quick Start

```bash
git clone https://github.com/JubinJean/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

初始化可以重复执行，不会覆盖已有配置。之后可在 Desktop 设置中配置模型，或在 CLI 配置中使用 `providers.<alias>.apiKeyEnv` 指定密钥环境变量。

## Usage

启动 Desktop：

```bash
pnpm desktop:dev
```

启动终端交互或执行单条任务：

```bash
pnpm dev -- tui
pnpm dev -- chat
pnpm dev -- run "梳理这个仓库，并说明最优先的风险点"
```

可从同一工作区的终端读取或回答当前等待中的问题（支持文本与 JSON 输出）：

```bash
biny input list --session <session-id> --json
biny input answer <tool-call-id> --session <session-id> --run <run-id> --question place --text "放到下载目录"
biny input answer <tool-call-id> --session <session-id> --run <run-id> --answers '[{"id":"place","selected":[],"text":"放到下载目录"}]' --json
biny input answer <tool-call-id> --session <session-id> --run <run-id> --skip
```

问题 ID 和运行 ID 以 `input list` 的结果为准；已结束或取消的问题不能再回答。

查看命令和具体功能的用法：

```bash
pnpm dev -- --help
pnpm dev -- memory --help
pnpm dev -- activity --help
pnpm dev -- browser --help
```

Desktop 设置中可配置聊天与网络搜索。WebSearch 仅在 Desktop 浏览器执行端可用时启用；WebFetch 在配置允许时可直接读取 HTTP 页面。浏览器扩展在「设置 → 浏览器」中配对。

浏览项目、工具目录和历史会话不会启动 Runtime Host；发送消息或执行需要运行时的操作才按项目数据目录启动或复用 Host。Desktop 启动的 Host 在无任务、后台进程或启用的调度职责时，空闲约 30 秒后退出；macOS 上不显示独立 Dock 图标。

退出 Desktop 时，确认后运行中的任务会留在本机后台 Runtime Host 继续执行，任务结束且无其他驻留职责后回收。依赖内置浏览器或桌面人工授权的步骤可能等待重新打开应用；关闭主窗口时可选择暂停任务。

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

TUI 改动可在目标项目中运行 `biny tui` 或 `biny chat` 验收；启动前先运行 `pnpm build:cli`。

## CI 与发布

GitHub Actions 会在 Pull Request 和 `main` / `master` 分支 push 时运行依赖审计、类型检查、lint、标准测试、Runtime E2E 和 CLI/Desktop 构建。发布时，在仓库 Actions 页面运行 **Prepare release** 并输入版本号；流程会更新版本、创建 tag，然后触发该 tag 的验证、macOS arm64/x64 打包和 GitHub Release 上传。也可以运行 **Release macOS app** 并输入已有 tag 来重建发布包。

正式发布需要在仓库的 Actions secrets 中配置 `MACOS_CERTIFICATE_BASE64`、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，供 macOS 应用签名与公证使用。

Pull Request 的自动代码审查由仓库规则集触发，目标分支为 `main`，每次新提交都会重新审查；草稿 PR 不触发。审查结果以评论提供，不作为合并批准，仍需维护者判断。此功能要求 PR 作者具备代码审查访问权限且额度可用；规则集配置位于 GitHub 仓库 Settings → Rulesets。
