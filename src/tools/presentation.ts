/** Display names and per-message menu eligibility; these never grant execution authority. */
import type { ToolExposure } from "./types.js";

export type ToolCapabilityGroup = "web" | "workspace" | "shell" | "planning";
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
  ComputerList: { label: "列出应用" },
  ComputerLaunch: { label: "打开应用" },
  ComputerObserve: { label: "查看电脑界面" },
  ComputerAction: { label: "操作电脑" },
  ComputerSequence: { label: "执行连续电脑操作" },
  ComputerMirror: { label: "同步电脑画面" },
  ChromeRelayScreenshot: { group: "web", label: "截取 Chrome 网页" },
  ChromeRelayScroll: { group: "web", label: "滚动 Chrome 网页" },
  ChromeRelayUpload: { group: "web", label: "上传文件到 Chrome 网页" },
  ChromeRelayDownload: { group: "web", label: "下载 Chrome 网页文件" },
  ChromeRelayWait: { group: "web", label: "等待 Chrome 网页" },
  skill_call: { label: "技能调用", selectable: false },
  WebFetch: { group: "web", label: "网络获取", detail: "抓取 URL 的原始内容。" },
  WebSearch: { group: "web", label: "网络搜索", detail: "在网上搜索最新信息。" },
  BrowserOpen: { group: "web", label: "打开网页", detail: "在 Biny 浏览器中打开网页。" },
  BrowserListEnvironments: { group: "web", label: "列出浏览器环境", detail: "查看可选的独立登录环境。" },
  BrowserReadDom: { group: "web", label: "读取网页", detail: "读取当前网页的文本和可交互元素。" },
  BrowserClick: { group: "web", label: "点击网页", detail: "点击网页上的可见元素。" },
  BrowserType: { group: "web", label: "填写网页", detail: "向网页输入框或编辑器填写内容。" },
  BrowserPress: { group: "web", label: "操作网页按键", detail: "向网页发送 Enter、Tab 等按键。" },
  ChromeRelayStatus: { group: "web", label: "Chrome 连接状态", detail: "检查日常浏览器扩展是否已连接。" },
  ChromeRelayListTabs: { group: "web", label: "Chrome 已有标签", detail: "列出日常浏览器已打开的网页。" },
  ChromeRelayRead: { group: "web", label: "读取 Chrome 网页", detail: "读取已有标签的文本与可交互元素。" },
  ChromeRelayNavigate: { group: "web", label: "导航 Chrome 标签", detail: "在已有标签中打开网址。" },
  ChromeRelayClick: { group: "web", label: "点击 Chrome 网页", detail: "点击已有标签中的元素。" },
  ChromeRelayType: { group: "web", label: "填写 Chrome 网页", detail: "填写已有标签中的输入框。" },
  ChromeRelayPress: { group: "web", label: "Chrome 网页按键", detail: "向已有标签发送 Enter、Tab 等按键。" },
  Read: { group: "workspace", label: "读取文件", detail: "读取文件、附件或工具归档内容。" },
  Glob: { group: "workspace", label: "列出文件", detail: "按 glob 模式列出匹配的文件。" },
  Grep: { group: "workspace", label: "搜索文件", detail: "在工作区文件中搜索文本。" },
  Write: { group: "workspace", label: "写入文件", detail: "用提供的内容覆盖文件。" },
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
