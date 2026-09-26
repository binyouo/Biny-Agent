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

查看命令和具体功能的用法：

```bash
pnpm dev -- --help
pnpm dev -- memory --help
pnpm dev -- activity --help
pnpm dev -- browser --help
```

Desktop 设置中可配置聊天与网络搜索。WebSearch 仅在 Desktop 浏览器执行端可用时启用；WebFetch 在配置允许时可直接读取 HTTP 页面。浏览器扩展在「设置 → 浏览器」中配对。

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

TUI 改动可在目标项目中运行 `biny tui` 或 `biny chat` 验收；启动前先运行 `pnpm build:cli`。
