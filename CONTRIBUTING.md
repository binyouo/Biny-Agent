# 贡献指南

欢迎通过 [Issues](https://github.com/binyouo/Biny-Agent/issues) 报告问题、讨论功能或提供修改。开始前先确认问题对应的操作入口、预期结果与当前版本。

## 开发环境

CI 使用 Node.js 22，项目使用 pnpm `10.6.5`。Desktop 可在 macOS 或 Windows 构建；原生 Computer Use、Activity 和日历 sidecar 仅在 macOS 构建。Windows 的 node-pty 原生重建需要 Visual Studio C++ Build Tools 与 Windows SDK。

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

Windows 使用相同的 `pnpm desktop:dev` 开发入口，`pnpm desktop:pack` 生成应用目录，`pnpm desktop:dist` 生成 NSIS 安装程序与 ZIP；安装包尚未配置 Windows 代码签名。这些命令先准备 Electron 与 PTY 原生依赖。macOS 的 `desktop:pack` 生成应用目录，`desktop:dist` 生成 DMG 安装包。

`node scripts/run-tests.mjs windows` 验证平台选择、真实 Host 多客户端连接、认证、退出重启与进程树清理；真实 DACL 用例仅在 Windows 运行。CI 的 Windows lane 另检查构建后的 Electron headless Host；打包输入变更或全量验证时生成安装包，不执行模型 API 或替代人工界面验收。Windows 上还需人工检查中文输入法、粘贴、快捷键、窗口与终端缩放、会话交接、终端关闭和安装卸载。

代码入口与数据职责见 [架构](docs/ARCHITECTURE.md)。终端展示使用 `@earendil-works/pi-tui`，Desktop 使用 Electron；界面层负责适配，运行与持久化逻辑在核心模块中维护。

## 行为变更

先写清输入、前置状态、操作和可观察结果，再添加有业务意义的回归测试。确认测试因目标行为尚未实现而失败，随后实现并验证；环境或装配错误不能代替这个失败阶段。

测试稳定入口的返回值、事件、文件或进程状态。模型、网络、MCP 和系统能力使用可注入的外部替身；不要模拟自己的领域实现，也不在确定性测试中调用真实模型 API。

涉及恢复、并发或副作用时，覆盖取消、超时、重复执行和已派发但结果未知的情况。测试数据可以使用真实模型名和协议所需技术标识。

## 验证入口

```bash
pnpm check:project
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

先运行覆盖目标行为的最小检查，再按影响范围运行上述入口。完整 CI 还包括产物检查和其他工作流要求，以 [ci.yml](.github/workflows/ci.yml) 为准。

单文件检查也可以通过 `node scripts/run-tests.mjs config-test-isolation` 运行；入口为每个测试进程创建并清理独立的 `BINY_AGENT_DIR`。直接运行测试时，配置、会话和凭据目录必须显式指向临时目录。测试及其派生进程会拒绝访问日常 Biny 数据目录，包括指向这些目录的符号链接；系统 Keychain 调用也被拒绝，持久凭据测试须注入独立的存储或命令替身。

CI 根据 Git 改动及源码反向依赖选择标准测试。PR 在实际合并结果上运行，以该合并提交的 base 父提交为比较基准，覆盖 PR 对当前 base 引入的改动；校验 head 和 base 均与事件一致。main 上尚未验证的历史改动由 push CI 从最近成功祖先累计验证，不让每个 PR 重复承担。PR 通过只表示所选范围通过，不代表 base 的既有失败已修复。纯测试文件变更选择该文件及其消费者；明确测试路径及显式拼接测试路径的 suite 名保留依赖，普通同名字符串不扩大范围。源码变更保留完整 Runtime E2E。运行依赖包含普通导入、字面量动态导入、`createRequire(import.meta.url)` 的字面量调用，以及测试对项目文件或目录的字面量读取（含相对 `import.meta.url` 的 URL）。明确擦除的 `import type`、`export type` 和类型查询不扩大运行测试范围；源码类型检查仍完整执行。

仅导入创建/清理临时目录及写文件的函数，不会让测试被所有源码改动触发。未知文件读取、读取函数转交、子进程、Vite SSR、VM、未解析的动态导入或 require 仍保守保留。选择器声明了两个已核对的外部输入边界：插件加载器从用户工作区 pluginRoot 导入插件，测试 owner 清理助手只读取经过临时根目录校验的记录和诊断；两者的普通源码依赖仍照常追踪。修改这些读取边界时须同步选择器和回归测试，不能把新增项目输入沿用为外部数据。

权限、Agent、Runtime、Session、配置、Provider/扩展等源码变更同样按反向依赖选择测试，不因所属目录直接触发全量。依赖、工作流、构建/测试脚本、共享测试夹具、删除/重命名、未知路径、无法解析的依赖或没有测试依赖的源码变更，运行全量。push 无法取得成功祖先时也运行全量；PR 的历史运行查询失败只失去耗时信息，不改变其比较范围。纯 README、贡献指南和 Markdown 文档变更只保留静态门禁。每日北京时间 03:17 的定时 CI 和手动 `workflow_dispatch` 均运行全量（包含 Windows 打包）；GitHub 调度实际启动时间可能延迟。发布前可手动运行完整 CI，不用局部验证代替发布检查。

测试计划与静态检查并行生成；标准测试、Runtime E2E、Linux 构建、Renderer 和 Windows 验证仅在两者均成功且计划选中后启动。静态检查失败或取消时，不启动这些高成本任务，最终 Validate 仍须报告失败。

标准测试按选中文件数最多分为 4 个任务；只有一个测试文件时只启动一个任务，没有标准测试时整组跳过。每个任务内逐文件执行并保留独立进程和数据目录。CI 从成功祖先的产物继承历史耗时，按长任务优先、当前累计耗时最少的分片分配；新测试使用已知测试耗时中位数。没有可用耗时则按名称排序轮流分配，不会因此减少测试。所有任务下载同一份计划，避免各自读取不同历史而造成漏项或重复。计划绑定 checkout 提交，提交变化后须重新生成。

`pnpm test` 仍默认运行完整测试集。可以检查或执行一个分片：

```bash
node scripts/run-tests.mjs --standard --shard=1/4 --list
pnpm test:standard --shard=1/4 --report=test-timings.json
```

本地也可以针对已提交的变更生成计划；`--base` 是已验证的祖先提交，依赖图读取当前工作区，先完成或另行验证未提交改动，不把它们当成该提交区间的验证结果：

```bash
node scripts/ci-test-plan.mjs --base <verified-commit>
node scripts/run-tests.mjs --standard --plan=.ci/plan.json --list
node scripts/run-tests.mjs --standard --plan=.ci/plan.json --shard=1/4 --report=test-timings.json
node scripts/ci-test-plan.mjs --full
```

计划记录基准、head、选择原因、测试文件和历史耗时；运行器只执行标准测试或 E2E，计划中要求的其他检查仍需单独运行。`--shard` 从 1 开始；所有分片覆盖计划选择的完整标准测试集且没有重复。`--report` 记录测试执行、清理和总耗时及退出码；失败时保留已执行结果并停止该分片，清理失败不能报告成功。PR 中一个分片失败后，取消尚未完成的其他标准测试分片；push、定时和手动运行保留其他分片继续诊断。已启动分片通过 `always()` 尝试上传已有报告，取消的分片不视为通过。最终 Validate 要求所有选中的任务通过，仅接受计划明确不需要的任务为 skipped；失败、取消、缺失均不算通过。

Windows 兼容测试和构建后的 Host 验证在源码变更、选中 Windows lane 执行的测试或全量验证时运行；无关的纯测试变更不启动 Windows 构建。类型检查统一在静态门禁执行，Windows 不重复运行。完整 NSIS/ZIP 打包只在全量验证时运行，所有打包配置、依赖、资源和脚本变更都属于全量触发范围。Renderer 记忆设置夹具只在其运行依赖受影响或全量验证时启动；未知动态依赖仍保守保留。Linux 构建由 Desktop 构建统一包含 CLI。测试运行器、计划器、模型元数据及 Code Mode runtime 的前置回归在静态任务运行一次，不在四个分片重复。

`pnpm test:runner` 验证影响选择、累计比较基准、全量回退、门禁、分片覆盖、失败传播和进程目录隔离，并在隔离夹具中实际执行选中测试与全量测试，确认两者都捕获注入的运行行为与文件输入错误。当前选择器对动态读取采取保守范围；受影响测试通过不等于所有未运行的行为都已验证。

项目依赖和文档检查的范围与限制见[开发规范](docs/DEVELOPMENT.md#可执行检查)。纯文档修改运行 `pnpm check:docs`；维护本地规格时再运行 `pnpm check:docs:local`，不需要运行无关模型任务或构建。Desktop、Web 与 TUI 的视觉和交互由人工验收，交付时提供操作步骤、预期表现与关键边界。

## 文档维护

功能事实的归属和修复链路检查遵循[开发与文档规范](docs/DEVELOPMENT.md)。公开专题说明放在 `docs/`，由[文档索引](docs/README.md) 引用；README 保持介绍与上手入口。

根据主题选择章节，不要求每页套用相同模板。Skill 的触发条件、Agent 操作步骤和输出要求属于运行指令；公开文档应帮助读者理解功能如何工作、结果从哪里来以及限制是什么。

## 发布约定

采用按里程碑手动发布，不固定每日或每次提交发版。完成一个可用功能或重要修复后，由维护者明确发起发布；零散小修与文档更新合并到下一版。普通提交、push 与 CI 成功不自动修改版本、创建 tag 或发布安装包。

当前 Beta 沿用 `0.0.1-beta.N`，每次新发布递增 `N`；已有 tag 不覆盖。工作流或验证环境故障可修复后按原 tag 重试；标签内的应用源码需要修改时创建新版本。进入稳定版或调整主版本时另行确定版本。发布前收齐本次范围内的并行改动，确认对应源码的 CI、构建和产物检查结果；安装、首次启动及界面交互的人工验收结果单独说明。

公开下载只提供 macOS Apple Silicon、Intel 各一份 DMG。`pnpm build:desktop` 先从应用原稿生成平台图标，打包使用同一批资源。发布工作流只构建、上传 DMG，不额外提供 ZIP 或校验和文件。

版本来源为 `package.json`。通过 [Prepare release](.github/workflows/prepare-release.yml) 手动输入新版本，工作流提交版本、创建 `v<version>` tag，再启动 [Release macOS app](.github/workflows/release-desktop.yml)。后者验证标签对应源码，构建两种架构并创建 GitHub Release；已有标签的失败构建可通过其 `tag` 输入重试。只有 Actions 成功且 Release 安装包实际上传完成，才算发布完成。

### macOS 签名与公证

站外分发使用 **Developer ID Application** 证书签署 App，并提交 Apple 公证、附加公证票据。Developer ID Installer 用于 PKG；当前 DMG 分发不需要该证书。需要有效的 [Apple Developer Program](https://developer.apple.com/programs/enroll/) 会员，证书创建步骤见 [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)，公证要求见 [Apple 官方说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。

在 Mac 的钥匙串生成证书签名请求，申请并安装 Developer ID Application 证书，将证书连同私钥导出为带密码的 `.p12`。在仓库 Settings → Secrets and variables → Actions 配置以下 Repository secrets：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | `.p12` 文件的 Base64 内容，工作流映射到 `CSC_LINK` |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码，映射到 `CSC_KEY_PASSWORD` |
| `APPLE_ID` | Apple 账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 账号生成的 App 专用密码 |
| `APPLE_TEAM_ID` | 开发者账号的 Team ID |

例如通过 `base64 < DeveloperID.p12 | gh secret set MACOS_CERTIFICATE_BASE64` 写入证书，其余值可用 `gh secret set <名称>` 交互录入。私钥和密码保留在钥匙串或 GitHub Secrets，不加入仓库或发布说明。

凭据配置后，发版时保持 `unsigned=false`；electron-builder 导入证书、签署 App 及嵌套组件，启用 Hardened Runtime 并执行公证。签名、公证失败会阻止发布。下载产物后用 `codesign --verify --deep --strict --verbose=2 Biny.app`、`spctl --assess --verbose --type exec Biny.app` 和 `xcrun stapler validate Biny.app` 核验，安装与系统权限仍需人工验收。

当前无 Apple 凭据时可显式选择 `unsigned=true`，仅允许 Beta；该模式使用 ad-hoc 签名并关闭 Hardened Runtime、公证与 Gatekeeper 构建评估，发布说明保留安装限制。稳定版不允许此模式。

## 交付与问题反馈

每个变更围绕一个清晰职责，保留无关工作区修改。Commit message 使用英文 Conventional Commits；提交前检查暂存范围和 `git diff --cached --check`。

问题报告尽量提供版本、系统、复现步骤、预期与实际结果及脱敏日志。不要公开模型密钥、MCP 令牌、配对地址或私有对话。

权限与执行边界见 [工具与权限](docs/PERMISSIONS.md)。第三方版权与许可证见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
