/** Display names and per-message menu eligibility; these never grant execution authority. */
import type { ToolExposure } from "./types.js";

export type ToolCapabilityGroup = "web" | "browser" | "chrome" | "computer" | "workspace" | "shell" | "planning";
export interface ToolPresentation {
  label: string;
  group?: ToolCapabilityGroup;
  detail?: string;
  selectable?: false;
}

const toolPresentations: Record<string, ToolPresentation> = {
  run_script: { label: "脚本处理", selectable: false },
  exec: { label: "运行脚本", selectable: false },
  apply_patch: { group: "workspace", label: "应用文件补丁", detail: "按补丁更新项目文件。" },
  recall_memory: { label: "检索记忆", selectable: false },
  save_memory: { label: "保存记忆", selectable: false },
  search_history: { label: "搜索历史", selectable: false },
  read_checkpoint_evidence: { label: "读取恢复证据", selectable: false },
  skill_lookup: { label: "查找技能", selectable: false },
  read_skill_resource: { label: "读取技能资源", selectable: false },
  skill_search: { label: "搜索技能", selectable: false },
  skill_install: { label: "安装技能", selectable: false },
  TaskCancel: { label: "取消子任务", selectable: false },
  TaskMessage: { label: "补充子任务上下文", selectable: false },
  TaskContinue: { label: "继续子任务", selectable: false },
  TaskReport: { label: "报告子任务进展", selectable: false },
  TaskStatus: { label: "查询子任务", selectable: false },
  PlanStart: { label: "启动计划", selectable: false },
  PlanStatus: { label: "查询计划", selectable: false },
  PlanUpdate: { label: "更新计划", selectable: false },
  PlanDraft: { label: "拟定计划", selectable: false },
  GoalGet: { label: "查看目标", selectable: false },
  GoalUpdate: { label: "更新目标", selectable: false },
  AskUserQuestion: { label: "向用户提问", selectable: false },
  WidgetReadme: { label: "读取组件说明", selectable: false },
  WidgetRenderer: { group: "planning", label: "展示交互组件", detail: "在对话中显示交互内容。" },
  ComputerList: { group: "computer", label: "列出应用" },
  ComputerLaunch: { group: "computer", label: "打开应用" },
  ComputerObserve: { group: "computer", label: "查看电脑界面" },
  ComputerAction: { group: "computer", label: "操作电脑" },
  ComputerSequence: { group: "computer", label: "执行连续电脑操作" },
  ComputerMirror: { group: "computer", label: "同步电脑画面" },
  ChromeRelayScreenshot: { group: "chrome", label: "截取 Chrome 网页" },
  ChromeRelayScroll: { group: "chrome", label: "滚动 Chrome 网页" },
  ChromeRelayUpload: { group: "chrome", label: "上传文件到 Chrome 网页" },
  ChromeRelayDownload: { group: "chrome", label: "下载 Chrome 网页文件" },
  ChromeRelayWait: { group: "chrome", label: "等待 Chrome 网页" },
  skill_call: { label: "技能调用", selectable: false },
  WebFetch: { group: "web", label: "网络获取", detail: "抓取 URL 的原始内容。" },
  WebSearch: { group: "web", label: "网络搜索", detail: "在网上搜索最新信息。" },
  BrowserOpen: { group: "browser", label: "打开网页", detail: "在 Biny 浏览器中打开网页。" },
  BrowserListEnvironments: { group: "browser", label: "列出浏览器环境", detail: "查看可选的独立登录环境。" },
  BrowserListProfiles: { group: "browser", label: "列出浏览器配置", detail: "查看本机可用的浏览器配置。", selectable: false },
  BrowserProfileHistory: { group: "browser", label: "查询浏览历史", detail: "按用户要求查询指定本机浏览器配置的记录。", selectable: false },
  BrowserReadDom: { group: "browser", label: "读取网页", detail: "读取当前网页的文本和可交互元素。" },
  BrowserScreenshot: { group: "browser", label: "浏览器截图", detail: "查看当前网页画面，按需另存 PNG。" },
  BrowserTabFloat: { group: "browser", label: "浮动浏览器标签", detail: "显示或收回当前会话的浏览器标签。", selectable: false },
  BrowserClick: { group: "browser", label: "点击网页", detail: "点击网页上的可见元素。" },
  BrowserType: { group: "browser", label: "填写网页", detail: "向网页输入框或编辑器填写内容。" },
  BrowserPress: { group: "browser", label: "操作网页按键", detail: "向网页发送 Enter、Tab 等按键。" },
  BrowserWait: { group: "browser", label: "等待网页状态", detail: "等待网页或唯一元素达到指定状态。" },
  BrowserUpload: { group: "browser", label: "上传网页文件", detail: "将工作区文件上传到当前网页。" },
  BrowserDownload: { group: "browser", label: "下载网页文件", detail: "保存网页链接或图片、音视频资源。" },
  BrowserExport: { group: "browser", label: "导出网页", detail: "导出网页或 Google Workspace 文件。" },
  BrowserBack: { group: "browser", label: "网页后退", detail: "在当前会话的内置浏览器标签中后退。" },
  BrowserForward: { group: "browser", label: "网页前进", detail: "在当前会话的内置浏览器标签中前进。" },
  BrowserReload: { group: "browser", label: "重新加载网页", detail: "重新加载当前会话的内置浏览器标签。" },
  BrowserClose: { group: "browser", label: "关闭网页标签", detail: "关闭当前会话拥有的内置浏览器标签。", selectable: false },
  BrowserScroll: { group: "browser", label: "滚动网页", detail: "按指定像素滚动内置浏览器页面。" },
  BrowserSelectOption: { group: "browser", label: "选择网页选项", detail: "设置网页下拉列表中的选项。" },
  BrowserSetChecked: { group: "browser", label: "设置网页勾选项", detail: "设置网页复选框或单选框状态。" },
  BrowserViewport: { group: "browser", label: "调整网页视口", detail: "模拟桌面或移动设备视口。", selectable: false },
  BrowserEval: { group: "browser", label: "执行网页表达式", detail: "在内置网页上下文中执行 JavaScript 表达式。", selectable: false },
  BrowserCDP: { group: "browser", label: "浏览器协议操作", detail: "执行高级浏览器协议命令，可能读取敏感数据或产生页面副作用。", selectable: false },
  BrowserClipboardRead: { group: "browser", label: "读取系统剪贴板", detail: "按用户要求读取剪贴板文本或图片。", selectable: false },
  BrowserClipboardWrite: { group: "browser", label: "写入系统剪贴板", detail: "按用户要求写入剪贴板文本。", selectable: false },
  BrowserDialogStatus: { group: "browser", label: "查看网页对话框", detail: "监听并查看内置网页的 JavaScript 对话框。", selectable: false },
  BrowserDialogRespond: { group: "browser", label: "响应网页对话框", detail: "接受或取消当前网页 JavaScript 对话框。", selectable: false },
  BrowserDialogAutoReply: { group: "browser", label: "自动响应网页对话框", detail: "按用户授权自动接受或取消当前网页的后续对话框。", selectable: false },
  ChromeRelayStatus: { group: "chrome", label: "Chrome 连接状态", detail: "检查日常浏览器扩展是否已连接。" },
  ChromeRelayListTabs: { group: "chrome", label: "Chrome 已有标签", detail: "列出日常浏览器已打开的网页。" },
  ChromeRelayRead: { group: "chrome", label: "读取 Chrome 网页", detail: "读取已有标签的文本与可交互元素。" },
  ChromeRelayEval: { group: "chrome", label: "执行 Chrome 网页表达式", detail: "在已有 Chrome 页面运行 JavaScript，需关键权限。", selectable: false },
  ChromeRelayNavigate: { group: "chrome", label: "导航 Chrome 标签", detail: "在已有标签中打开网址。" },
  ChromeRelayClick: { group: "chrome", label: "点击 Chrome 网页", detail: "点击已有标签中的元素。" },
  ChromeRelayType: { group: "chrome", label: "填写 Chrome 网页", detail: "填写已有标签中的输入框。" },
  ChromeRelayPress: { group: "chrome", label: "Chrome 网页按键", detail: "向已有标签发送 Enter、Tab 等按键。" },
  Read: { group: "workspace", label: "读取文件", detail: "读取文件、附件或工具归档内容。" },
  Glob: { group: "workspace", label: "查找文件", detail: "按文件名或路径查找，如 src/**/*.ts。" },
  Grep: { group: "workspace", label: "ripgrep 搜索", detail: "在项目文件内容中搜索文本或正则表达式。" },
  Write: { group: "workspace", label: "写入文件", detail: "新建文件，或覆盖已有文件的全部内容。" },
  Edit: { group: "workspace", label: "编辑文件", detail: "精确替换文件中的文本片段。" },
  Bash: { group: "shell", label: "执行命令", detail: "执行有限命令或启动托管的后台命令。" },
  ProcessStatus: { group: "shell", label: "进程状态", detail: "列出后台进程，查看状态并分页读取输出。" },
  KillShell: { group: "shell", label: "停止命令", detail: "停止后台命令的整个进程组。" },
  TodoWrite: { group: "planning", label: "待办同步", selectable: false, detail: "更新当前多步任务清单并展示进度。" },
  Task: { group: "planning", label: "任务委派", detail: "启动子代理处理多步骤任务。" },
  Skill: { group: "planning", label: "技能调用", detail: "调用已启用的技能或工作流。" },
  ToolSearch: { label: "搜索工具", selectable: false }
};

export function toolPresentation(name: string): ToolPresentation | undefined {
  return Object.hasOwn(toolPresentations, name) ? toolPresentations[name] : undefined;
}

/** Unknown extension names remain authoritative; do not infer namespace boundaries from underscores. */
export function toolDisplayName(name: string): string {
  return toolPresentation(name)?.label ?? (name.startsWith("mcp_") && name.length > 4 ? "MCP 工具" : name);
}

export function isToolUserSelectable(tool: { name: string; exposure?: ToolExposure }): boolean {
  return tool.exposure !== "hidden" && tool.exposure !== "model-only" && toolPresentation(tool.name)?.selectable !== false;
}
