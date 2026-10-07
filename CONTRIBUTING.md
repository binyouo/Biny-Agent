# 贡献指南

欢迎通过 [Issues](https://github.com/binyouo/Biny-Agent/issues) 报告问题、讨论功能或提供修改。开始前先确认问题对应的操作入口、预期结果与当前版本。

## 开发环境

CI 使用 Node.js 22，项目使用 pnpm `10.6.5`。Desktop 与原生 Computer Use 的完整构建需要 macOS。

```bash
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

通过 [模型与配置](docs/CONFIGURATION.md) 配置服务商。运行记录、系统权限和模型凭据保留在本机，不加入 Git。

## 运行与构建

```bash
pnpm dev -- chat
pnpm desktop:dev
pnpm build:cli
pnpm build
```

`build:cli` 只构建 CLI；`build` 包含 CLI、Desktop 及原生依赖构建。在其他项目使用当前 CLI 时，先执行 `pnpm link --global`，再切到目标项目运行 `biny`。

代码入口与数据职责见 [架构](docs/ARCHITECTURE.md)。终端展示使用 `@earendil-works/pi-tui`，Desktop 使用 Electron；界面层负责适配，运行与持久化逻辑在核心模块中维护。

## 行为变更

先写清输入、前置状态、操作和可观察结果，再添加有业务意义的回归测试。确认测试因目标行为尚未实现而失败，随后实现并验证；环境或装配错误不能代替这个失败阶段。

测试稳定入口的返回值、事件、文件或进程状态。模型、网络、MCP 和系统能力使用可注入的外部替身；不要模拟自己的领域实现，也不在确定性测试中调用真实模型 API。

涉及恢复、并发或副作用时，覆盖取消、超时、重复执行和已派发但结果未知的情况。测试数据可以使用真实模型名和协议所需技术标识。

## 验证入口

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

先运行覆盖目标行为的最小检查，再按影响范围运行上述入口。完整 CI 还包括产物检查和其他工作流要求，以 [ci.yml](.github/workflows/ci.yml) 为准。

单文件检查也可以通过 `node scripts/run-tests.mjs config-test-isolation` 运行；入口为每个测试进程创建并清理独立的 `BINY_AGENT_DIR`。直接运行测试时，配置、会话和凭据目录必须显式指向临时目录。测试及其派生进程会拒绝访问日常 Biny 数据目录，包括指向这些目录的符号链接；系统 Keychain 调用也被拒绝，持久凭据测试须注入独立的存储或命令替身。

纯文档修改检查路径、命令、链接和格式；不需要运行无关模型任务或构建。Desktop、Web 与 TUI 的视觉和交互由人工验收，交付时提供操作步骤、预期表现与关键边界。

## 文档维护

公开专题说明放在 `docs/`，并从 [文档索引](docs/README.md) 和首页链接。README 保持介绍与上手入口。专题页说明功能的实际作用、执行链路、数据和状态，再提供需要的配置与操作示例；涉及实现时链接对应源码，内容以当前代码为依据。

根据主题选择章节，不要求每页套用相同模板。Skill 的触发条件、Agent 操作步骤和输出要求属于运行指令；公开文档应帮助读者理解功能如何工作、结果从哪里来以及限制是什么。

新增公开页面时更新 `.gitignore` 的明确放行名单。本地规格、设计草稿、参考笔记和运行日志继续保留在本机；不通过开放整个目录来发布文档。

代码、文档和测试分别说明实现、使用契约和验证结果。功能变化同步相关说明；验证通过时写实际范围，不把一次局部检查称作完整验收。

## 交付与问题反馈

每个变更围绕一个清晰职责，保留无关工作区修改。Commit message 使用英文 Conventional Commits；提交前检查暂存范围和 `git diff --cached --check`。

问题报告尽量提供版本、系统、复现步骤、预期与实际结果及脱敏日志。不要公开模型密钥、MCP 令牌、配对地址或私有对话。

权限与执行边界见 [工具与权限](docs/PERMISSIONS.md)。第三方版权与许可证见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
