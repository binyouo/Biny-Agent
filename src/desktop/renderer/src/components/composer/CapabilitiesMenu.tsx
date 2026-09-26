/**
 * 本条消息的工具与技能选择器（能力菜单）。
 *
 * 先选择「工具 / 技能」和搜索，再调整选择方式；工具使用有名称的分组列表，
 * MCP 服务器按需展开。选择值沿用 AgentCapabilitySelection 协议：auto / all 之外是
 * 工具名数组，只随当前这条消息传给 Runtime，不写入会话配置。
 *
 * 内置工具的中文展示信息在 TOOL_PRESENTATIONS 里静态维护；内部编排工具不进入用户菜单，
 * MCP 工具也只在下方的服务器选择器中管理，避免把执行协议泄露成一长串函数清单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilitySelection, CapabilitySelectionValue } from "../../../../../agent/capabilitySelection.js";
import type { DesktopMcpServerSummary, DesktopSkillCatalogEntry, DesktopToolCatalogEntry } from "../../../../protocol.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { useFluidHoverItems } from "../../useFluidHoverItems.js";
import { FluidHoverHighlight } from "../FluidHoverHighlight.js";
import { Icon, type IconName } from "../Icon.js";
import { ComposerPopover } from "./ComposerPopover.js";
import { applyCapabilityNames, toggleCapabilityName } from "./capabilitySelectionLogic.js";
import { compareCapabilitySkills, compareCapabilityTools, shouldShowToolInCapabilityMenu, skillCapabilityGroupId, SKILL_CAPABILITY_GROUPS, type SkillCapabilityGroupId } from "./capabilityVisibility.js";

type CapabilityTab = "tools" | "skills";

type ToolGroupId = "web" | "workspace" | "shell" | "planning";

/** 展示分组；与注册表 source 无关，仅决定菜单里的类别与顺序。 */
const TOOL_GROUPS: Array<{ id: ToolGroupId; label: string; icon: IconName }> = [
  { id: "workspace", label: "项目与文件", icon: "folder-open" },
  { id: "shell", label: "Shell 与进程", icon: "terminal" },
  { id: "web", label: "网络与搜索", icon: "site" },
  { id: "planning", label: "规划与指令", icon: "list-tree" }
];

interface ToolPresentation {
  group: ToolGroupId;
  label: string;
  /** 中文一句话描述；省略时回落到工具目录里的原始描述。 */
  detail?: string;
}

/** 内置工具的展示映射；键为工具注册名。 */
const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  WebFetch: { group: "web", label: "网络获取", detail: "抓取 URL 的原始内容。" },
  WebSearch: { group: "web", label: "网络搜索", detail: "在网上搜索最新信息。" },
  BrowserOpen: { group: "web", label: "打开网页", detail: "在 Biny 浏览器中打开网页。" },
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
  Read: { group: "workspace", label: "读取文件", detail: "读取文件内容以获取上下文。" },
  Glob: { group: "workspace", label: "列出文件", detail: "按 glob 模式列出匹配的文件。" },
  Grep: { group: "workspace", label: "搜索文件", detail: "在工作区文件中搜索文本。" },
  Write: { group: "workspace", label: "写入文件", detail: "用提供的内容覆盖文件。" },
  Edit: { group: "workspace", label: "编辑文件", detail: "精确替换文件中的文本片段。" },
  Bash: { group: "shell", label: "执行命令", detail: "执行有限命令或启动托管的后台命令。" },
  BashOutput: { group: "shell", label: "后台输出", detail: "列出后台命令或分页读取状态和输出。" },
  KillShell: { group: "shell", label: "停止命令", detail: "停止后台命令的整个进程组。" },
  TodoWrite: { group: "planning", label: "待办同步", detail: "执行计划时更新共享待办列表。" },
  Task: { group: "planning", label: "任务委派", detail: "启动子代理处理多步骤任务。" },
  Skill: { group: "planning", label: "技能调用", detail: "调用已启用的技能或工作流。" },
  ToolSearch: { group: "planning", label: "工具搜索", detail: "按名称或描述发现可用工具。" }
};

/** 没有静态映射的工具按来源落入兜底分组。 */
const SOURCE_GROUPS: Record<Exclude<DesktopToolCatalogEntry["source"], "mcp">, { label: string; icon: IconName }> = {
  builtin: { label: "其他工具", icon: "wrench" },
  plugin: { label: "插件工具", icon: "puzzle" },
  skill: { label: "技能工具", icon: "wand" },
  subagent: { label: "子 Agent", icon: "person" }
};

/** MCP 工具描述以 `[MCP 服务器名]` 开头；用它把工具归回所属服务器。 */
const MCP_DESCRIPTION_PREFIX = /^\[MCP ([^\]]+)\]\s*/;

interface ToolGroup {
  key: string;
  label: string;
  icon: IconName;
  /** 分组标签右侧的小徽标文字（如 MCP 服务器名旁的 “MCP”）。 */
  badge?: string;
  entries: Array<{
    name: string;
    label: string;
    detail: string;
  }>;
}

interface SkillGroup extends ToolGroup {
  key: `skill:${SkillCapabilityGroupId}`;
}

export function CapabilitiesMenu({ anchorRef, onOpenMcpSettings, onRefreshCatalog, onWarning, open, projectId, resourceState, resourceRevision, skillWarnings, onChange, selection, skills, toolsSupported, tools }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 打开 MCP 设置页；未提供时隐藏设置入口。 */
  onOpenMcpSettings?(): void;
  /** 让上层重新拉取工具目录（MCP 刷新按钮用到）。 */
  onRefreshCatalog?(): void;
  onWarning?(message: string): void;
  open: boolean;
  projectId?: string;
  resourceState?: "loading" | "ready" | "degraded";
  resourceRevision?: number;
  skillWarnings?: string[];
  onChange(selection: AgentCapabilitySelection): void;
  selection: AgentCapabilitySelection;
  skills: DesktopSkillCatalogEntry[];
  toolsSupported: boolean;
  tools: DesktopToolCatalogEntry[];
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const [tab, setTab] = useState<CapabilityTab>("tools");
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<DesktopMcpServerSummary[]>();
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string>();
  const [reconnecting, setReconnecting] = useState<string>();
  const requestRef = useRef(0);
  useEffect(() => () => { requestRef.current += 1; }, []);

  // 定位和入场完成后再聚焦，避免浏览器把仍在屏幕外的浮层滚入视口。
  useEffect(() => {
    if (open && presence.phase === "open") searchRef.current?.focus({ preventScroll: true });
  }, [open, presence.phase]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setMcpOpen(false);
  }, [open]);

  const loadMcpServers = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const request = ++requestRef.current;
    setMcpBusy(true);
    setMcpError(undefined);
    try {
      const snapshot = await window.biny.mcpSnapshot(projectId);
      if (request !== requestRef.current) return;
      setMcpServers(snapshot.servers.filter((server) => server.enabled));
    } catch (error) {
      if (request === requestRef.current) setMcpError(`无法读取 MCP 服务器状态：${errorMessage(error)}`);
    } finally {
      if (request === requestRef.current) setMcpBusy(false);
    }
  }, [projectId]);

  // 弹层展开期间跟随 Runtime 修订刷新，关闭后停止查询；不缓存上次打开的连接状态。
  useEffect(() => {
    if (!open || !mcpOpen) return;
    void loadMcpServers();
  }, [loadMcpServers, open, mcpOpen, resourceRevision]);

  const reconnectMcp = async (name: string): Promise<void> => {
    if (!projectId || reconnecting) return;
    setReconnecting(name);
    try {
      await window.biny.mcpReconnect(projectId, name);
      await loadMcpServers();
      onRefreshCatalog?.();
    } catch (error) {
      onWarning?.(`MCP 重连失败：${errorMessage(error)}`);
    } finally {
      setReconnecting(undefined);
    }
  };

  const refreshMcp = useCallback(async (): Promise<void> => {
    await loadMcpServers();
    onRefreshCatalog?.();
  }, [loadMcpServers, onRefreshCatalog]);

  const toolGroups = useMemo(() => buildToolGroups(tools, normalizedQuery(query)), [query, tools]);
  const skillGroups = useMemo(() => buildSkillGroups(skills, normalizedQuery(query)), [query, skills]);
  const visibleToolNames = useMemo(() => tools.filter(shouldShowToolInCapabilityMenu).sort(compareCapabilityTools).map((tool) => tool.name), [tools]);
  const allMcpToolNames = useMemo(() => tools.filter((tool) => tool.source === "mcp").sort(compareCapabilityTools).map((tool) => tool.name), [tools]);
  const allToolNames = useMemo(() => [...visibleToolNames, ...allMcpToolNames], [allMcpToolNames, visibleToolNames]);
  const allSkillNames = useMemo(() => [...skills].sort(compareCapabilitySkills).map((skill) => skill.ref), [skills]);
  // 列表与搜索共用一套条目，避免同一能力在不同布局中依赖图标辨认。
  const listRef = useRef<HTMLDivElement>(null);
  const listHover = useFluidHoverItems(listRef, ".capability-row");

  if (!presence.present) return null;

  const value = selection[tab];
  const isAuto = value === "auto";
  const explicit = explicitNames(value);
  const allNames = tab === "tools" ? allToolNames : allSkillNames;
  const activeGroups = tab === "tools" ? toolGroups : skillGroups;
  const hasItems = activeGroups.length > 0;
  const mcpServerSelection = mcpServerSelectionState(value, tools, mcpServers);

  const setMode = (next: CapabilitySelectionValue): void => {
    onChange({ ...selection, [tab]: next });
  };
  const toggleEntry = (name: string): void => {
    onChange({ ...selection, [tab]: toggleCapabilityName(value, name, allNames) });
  };
  const toggleGroupEntries = (group: ToolGroup): void => {
    const keys = group.entries.map((entry) => entry.name);
    const allSelected = groupSelectionState(value, keys) === "all";
    onChange({ ...selection, [tab]: applyCapabilityNames(value, keys, allNames, !allSelected) });
  };

  return (
    <ComposerPopover anchorRef={anchorRef} className={`t-dropdown composer-popover biny-composer-popover capabilities-menu ${presenceClass(presence.phase)}`} phase={presence.phase}>
      <div aria-label="工具与技能" className="capabilities-panel" role="dialog">
        <div aria-label="能力类型" className="capabilities-tabs" role="group">
          <TabButton active={tab === "tools"} count={explicitNames(selection.tools)?.length} label="工具" onSelect={() => setTab("tools")} />
          <TabButton active={tab === "skills"} count={explicitNames(selection.skills)?.length} label="技能" onSelect={() => setTab("skills")} />
        </div>
        <label className="capabilities-search">
          <Icon name="search" size={14} />
          <input aria-label={tab === "tools" ? "搜索工具" : "搜索技能"} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "tools" ? "搜索工具…" : "搜索技能…"} ref={searchRef} type="search" value={query} />
        </label>
        <div className="capabilities-modes">
          <div aria-label="选择方式" className="capabilities-mode-row" role="group">
            <button aria-pressed={isAuto} className="capability-mode-button" onClick={() => setMode("auto")} type="button">自动选择</button>
            <button aria-pressed={value === "all"} className="capability-mode-button" onClick={() => setMode("all")} type="button">全部</button>
            <button aria-pressed={explicit !== undefined && explicit.length === 0} className="capability-mode-button" onClick={() => setMode([])} type="button">不使用</button>
          </div>
          {tab === "tools" && !toolsSupported ? (
            <p className="capabilities-mode-desc is-warning">当前模型不支持工具调用，切换模型后生效</p>
          ) : null}
        </div>
        <div aria-label={tab === "tools" ? "工具列表" : "技能列表"} className="capabilities-scroll" ref={listRef} role="group" {...listHover.handlers}>
          <FluidHoverHighlight hover={listHover} className="has-option-radius" />
          <CapabilityGroups groups={activeGroups} value={value} onToggle={toggleEntry} onToggleGroup={toggleGroupEntries} />
          {resourceState === "loading" ? <p className="capabilities-loading" role="status"><span className="capabilities-spinner" />正在准备工具与技能…</p> : null}
          {tab === "skills" && skillWarnings?.length ? <div className="capabilities-diagnostics" role="status">{skillWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div> : null}
          {!hasItems && resourceState !== "loading" ? <p className="capabilities-empty">{query.trim() ? "没有匹配的能力" : tab === "tools" ? "当前项目没有可用工具" : "当前项目没有启用的技能"}</p> : null}
        </div>
        {tab === "tools" ? (
          <div className="capabilities-mcp">
            <div className="capabilities-mcp-head">
              <button aria-expanded={mcpOpen} className="capabilities-mcp-toggle" onClick={() => setMcpOpen((current) => !current)} type="button">
                <Icon className="is-chevron" name="chevron" size={12} />
                <Icon name="plug" size={13} />
                <span>MCP 服务器</span>
                {resourceState === "loading" ? <span className="capabilities-spinner" /> : null}
                {mcpServerSelection.selected > 0 ? <span className="capabilities-mcp-count">{mcpServerSelection.selected}</span> : null}
              </button>
              <div className="capabilities-mcp-actions">
                <button aria-label="刷新 MCP 服务器" className="capabilities-mcp-action" disabled={mcpBusy} onClick={() => void refreshMcp()} type="button"><Icon name="refresh" size={13} /></button>
                {onOpenMcpSettings ? (
                  <button aria-label="打开 MCP 设置" className="capabilities-mcp-action" onClick={onOpenMcpSettings} type="button"><Icon name="settings" size={13} /></button>
                ) : null}
              </div>
            </div>
            {mcpOpen ? (
              <div className="capabilities-mcp-body">
                {mcpError ? <p className="capabilities-diagnostics" role="alert">{mcpError}</p> : null}
                {mcpServers === undefined ? (
                  mcpBusy ? <p className="capabilities-loading" role="status"><span className="capabilities-spinner" />正在读取 MCP 服务器…</p> : null
                ) : mcpServers.length === 0 ? (
                  <div className="capabilities-mcp-empty">
                    <Icon name="server" size={18} />
                    <span>未安装 MCP 服务器</span>
                    {onOpenMcpSettings ? <button onClick={onOpenMcpSettings} type="button">前往设置</button> : null}
                  </div>
                ) : (
                  <>
                    <div className="capabilities-mcp-quick">
                      <button disabled={mcpServerSelection.selected === mcpServers.length} onClick={() => onChange({ ...selection, tools: applyCapabilityNames(value, allMcpToolNames, allToolNames, true) })} type="button">全选</button>
                      <button disabled={mcpServerSelection.selected === 0} onClick={() => onChange({ ...selection, tools: applyCapabilityNames(value, allMcpToolNames, allToolNames, false) })} type="button">全不选</button>
                    </div>
                    <div className="capabilities-mcp-rows">
                      {mcpServers.map((server) => {
                        const checked = mcpServerSelection.checked.has(server.name);
                        const connecting = server.state === "connecting" || reconnecting === server.name;
                        return (
                          <div className="capabilities-mcp-row" data-state={server.state} key={server.name}>
                            <button disabled={!server.toolNames.length || server.state !== "connected"} aria-checked={checked} aria-label={`${checked ? "停用" : "启用"} ${server.name}`} className="capability-check" onClick={() => {
                              const serverTools = tools.filter((tool) => tool.source === "mcp" && mcpServerOf(tool) === server.name).map((tool) => tool.name);
                              if (serverTools.length === 0) return;
                              onChange({ ...selection, tools: applyCapabilityNames(value, serverTools, allToolNames, !checked) });
                            }} role="switch" type="button"><Icon name="check" size={12} /></button>
                            {connecting ? <span aria-label="连接中" role="status" className="capabilities-spinner" /> : <span aria-label={server.state === "connected" ? "已连接" : "未连接"} role="img" className={`capabilities-mcp-state is-${server.state}`} />}
                            <span className="capabilities-mcp-name" title={server.description ?? server.name}>{server.name}</span>
                            {!connecting && server.state === "disconnected" ? <span className="capabilities-mcp-badge is-error">未连接</span> : null}
                            {!connecting && server.state === "not-started" ? <span className="capabilities-mcp-badge">未启动</span> : null}
                            {server.state !== "connected" ? <button aria-label={`重新连接 ${server.name}`} className="capabilities-mcp-action" disabled={Boolean(reconnecting) || server.state === "connecting"} onClick={() => void reconnectMcp(server.name)} type="button"><Icon name="refresh" size={13} /></button> : null}
                            {connecting ? <span className="capabilities-mcp-badge">连接中</span> : null}
                            {!connecting && server.lastError ? <p className="capabilities-mcp-error">{server.lastError}</p> : null}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </ComposerPopover>
  );
}

/** 工具与技能共用选择语义，自动、全部和显式选择在两类列表中保持一致。 */
function CapabilityGroups({ groups, value, onToggle, onToggleGroup }: {
  groups: ToolGroup[];
  value: CapabilitySelectionValue;
  onToggle(name: string): void;
  onToggleGroup(group: ToolGroup): void;
}): React.JSX.Element {
  return <>{groups.map((group) => {
    const state = groupSelectionState(value, group.entries.map((entry) => entry.name));
    return (
      <div className="capability-group" key={group.key}>
        <div className="capability-group-head">
          <span className="capability-group-title"><Icon name={group.icon} size={13} />{group.label}{group.badge ? <span className="capability-group-badge">{group.badge}</span> : null}</span>
          <button aria-checked={state === "all" ? true : state === "some" ? "mixed" : false} aria-label={state === "all" ? "全不选该分类" : "全选该分类"} className="capability-group-check" onClick={() => onToggleGroup(group)} role="checkbox" type="button">
            {state === "all" ? <Icon name="check" size={12} /> : state === "some" ? <Icon name="minus" size={12} /> : null}
          </button>
        </div>
        {group.entries.map((entry) => (
          <ListRow ariaChecked={isNameSelected(value, entry.name)} detail={entry.detail} key={entry.name} label={entry.label} onToggle={() => onToggle(entry.name)} />
        ))}
      </div>
    );
  })}</>;
}

function ListRow({ ariaChecked, detail, label, onToggle }: { ariaChecked: boolean; detail: string; label: string; onToggle(): void }): React.JSX.Element {
  return (
    <button aria-checked={ariaChecked} className="capability-row" onClick={onToggle} role="checkbox" type="button">
      <span className="capability-check"><Icon name="check" size={12} /></span>
      <span className="capability-row-copy"><strong>{label}</strong><small>{detail}</small></span>
    </button>
  );
}

function TabButton({ active, count, label, onSelect }: { active: boolean; count: number | undefined; label: string; onSelect(): void }): React.JSX.Element {
  return (
    <button aria-pressed={active} className={`capabilities-tab${active ? " is-selected" : ""}`} onClick={onSelect} type="button">
      {label}
      {count !== undefined && count > 0 ? <small>{count}</small> : null}
    </button>
  );
}

/** 工具目录 → 展示分组；MCP 和内部协调工具由独立入口管理。 */
function buildToolGroups(tools: DesktopToolCatalogEntry[], query: string): ToolGroup[] {
  const buckets = new Map<string, ToolGroup>();
  const bucket = (key: string, label: string, icon: IconName, badge?: string): ToolGroup => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: ToolGroup = { key, label, icon, badge, entries: [] };
    buckets.set(key, created);
    return created;
  };
  for (const tool of [...tools].sort(compareCapabilityTools)) {
    if (!shouldShowToolInCapabilityMenu(tool)) continue;
    // 保留显式分支让类型系统知道这里已经进入内置/插件/技能/子 Agent 分组。
    if (tool.source === "mcp") continue;
    const presentation = TOOL_PRESENTATIONS[tool.name];
    let group: ToolGroup;
    let label: string;
    let detail: string;
    if (presentation) {
      const declared = TOOL_GROUPS.find((entry) => entry.id === presentation.group);
      group = bucket(presentation.group, declared?.label ?? "其他工具", declared?.icon ?? "wrench");
      label = presentation.label;
      detail = presentation.detail ?? tool.description;
    } else {
      const source = SOURCE_GROUPS[tool.source];
      group = bucket(`source:${tool.source}`, source.label, source.icon);
      label = tool.name;
      detail = tool.description;
    }
    if (query && !`${label} ${detail} ${tool.name}`.toLocaleLowerCase().includes(query)) continue;
    group.entries.push({ name: tool.name, label, detail });
  }
  // 分组按 TOOL_GROUPS 声明顺序输出；来源与 MCP 分组按首次出现顺序跟在后面。
  const ordered: ToolGroup[] = [];
  for (const declared of TOOL_GROUPS) {
    const found = buckets.get(declared.id);
    if (found && found.entries.length > 0) ordered.push(found);
    buckets.delete(declared.id);
  }
  for (const remaining of buckets.values()) {
    if (remaining.entries.length > 0) ordered.push(remaining);
  }
  return ordered.map((group) => ({ ...group, entries: group.entries.sort(compareCapabilityTools) }));
}

function buildSkillGroups(skills: DesktopSkillCatalogEntry[], query: string): SkillGroup[] {
  const buckets = new Map<SkillCapabilityGroupId, SkillGroup>();
  for (const skill of [...skills].sort(compareCapabilitySkills)) {
    const label = skill.name;
    const detail = skill.description || "暂无描述";
    if (query && !`${label} ${detail} ${skill.ref}`.toLocaleLowerCase().includes(query)) continue;
    const groupId = skillCapabilityGroupId(skill);
    const groupDefinition = SKILL_CAPABILITY_GROUPS.find((group) => group.id === groupId);
    const bucket = buckets.get(groupId) ?? {
      key: `skill:${groupId}`,
      label: groupDefinition?.label ?? "技能",
      icon: groupDefinition?.icon ?? "wand",
      entries: []
    };
    bucket.entries.push({ name: skill.ref, label, detail });
    buckets.set(groupId, bucket);
  }
  return SKILL_CAPABILITY_GROUPS
    .map((group) => buckets.get(group.id))
    .filter((group): group is SkillGroup => group !== undefined);
}

/** 展示用服务器勾选状态：auto / all 视为全选；显式数组按「该服务器工具全部勾选」判定。 */
function mcpServerSelectionState(value: CapabilitySelectionValue, tools: DesktopToolCatalogEntry[], servers: DesktopMcpServerSummary[] | undefined): { checked: Set<string>; selected: number } {
  const checked = new Set<string>();
  if (!servers) return { checked, selected: 0 };
  for (const server of servers) {
    const serverTools = tools.filter((tool) => tool.source === "mcp" && mcpServerOf(tool) === server.name).map((tool) => tool.name);
    if (serverTools.length === 0) continue;
    if (groupSelectionState(value, serverTools) === "all") checked.add(server.name);
  }
  return { checked, selected: checked.size };
}

/** 单个能力是否勾选：all 视为全选；auto 不展示勾选（首次点击即从 auto 进入逐项选择）。 */
function isNameSelected(value: CapabilitySelectionValue, name: string): boolean {
  if (value === "auto") return false;
  if (value === "all") return true;
  return value !== "none" && value.includes(name);
}

/** 分组勾选状态：all=全选 some=部分 none=未选；auto 与「未逐项选择」同义。 */
function groupSelectionState(value: CapabilitySelectionValue, names: string[]): "all" | "some" | "none" {
  if (value === "auto") return "none";
  if (value === "all") return "all";
  const current = value === "none" ? [] : value;
  const selected = names.filter((name) => current.includes(name)).length;
  if (selected === 0) return "none";
  return selected === names.length ? "all" : "some";
}

/** 显式数组；auto / all 返回 undefined 表示未进入逐项选择。 */
function explicitNames(value: CapabilitySelectionValue): string[] | undefined {
  if (value === "auto" || value === "all") return undefined;
  return value === "none" ? [] : value;
}

function mcpServerOf(tool: DesktopToolCatalogEntry): string | undefined {
  if (tool.source !== "mcp") return undefined;
  return MCP_DESCRIPTION_PREFIX.exec(tool.description)?.[1];
}

/** 当前显式选择的总项数；auto / all 不计入（触发 pill 与页签计数只反映逐项选择）。 */
function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
