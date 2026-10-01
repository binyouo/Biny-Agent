<h1 align="center">Biny</h1>

<p align="center">本地优先的开发协作 Agent，提供 macOS Desktop、TUI 与 CLI。</p>

<p align="center">
  <a href="https://github.com/binyouo/Biny-Agent">GitHub</a> ·
  <a href="#about">项目简介</a> ·
  <a href="#quick-start">快速开始</a>
</p>

> 项目仍在积极开发中，命令和行为可能随版本变化。

## About

Biny 帮助你在本地项目中对话、处理开发任务并延续跨会话上下文。Desktop、TUI 与 CLI 共用会话和配置；本地记忆可保留工作背景，也可通过 MCP、插件和技能扩展能力。

## Quick Start

从源码安装并初始化：

```bash
git clone https://github.com/binyouo/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

配置模型后，启动终端对话或 Desktop：

```bash
pnpm dev -- chat
pnpm desktop:dev
```

命令帮助：`pnpm dev -- --help`。
