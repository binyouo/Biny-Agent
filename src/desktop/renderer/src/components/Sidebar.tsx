/**
 * 桌面端主侧栏。
 *
 * 侧栏的数据仍由 App 投影，组件只负责把项目、会话和菜单动作组织成置顶项目、普通项目
 * 和未归类对话三段树。项目与会话的业务操作通过回调返回上层，避免把 IPC 和持久化状态
 * 复制到视觉组件中。
 */
import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SidebarLayoutSnapshot } from "../../../sidebarLayout.js";
import { clampSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../../../sidebarSizing.js";
import type { DesktopProject, DesktopSessionMenuAction, DesktopSessionSummary, DesktopSessionTreePage } from "../../../protocol.js";
import type { SidebarPeekHandlers, SidebarResizeHandlers } from "../app/useSidebarLayout.js";
import { useClosingPresence } from "../useClosingPresence.js";
import { useFluidHover, useRegisterFluidHoverItem, type UseFluidHoverReturn } from "../useFluidHover.js";
import { Collapse } from "./Collapse.js";
import { CrystalDock } from "./CrystalDock.js";
import { DiaryDock } from "./DiaryDock.js";
import { FluidHoverHighlight } from "./FluidHoverHighlight.js";
import { Icon, type IconName } from "./Icon.js";
import { WorkingIndicator } from "./WorkingIndicator.js";

const PROJECT_SESSION_COLLAPSE_LIMIT = 5;
const DIALOGUE_SESSION_COLLAPSE_LIMIT = 10;

type SidebarSectionName = "pinned" | "projects" | "dialogue";
type ProjectSort = "priority" | "recent" | "manual";
type ProjectDragPlacement = "before" | "after";
type FloatingMenuAnchor = { readonly current: HTMLElement | null };
interface ProjectDragState {
  sourceId: string;
  targetId?: string;
  placement?: ProjectDragPlacement;
  section: "pinned" | "projects";
}

interface SidebarProps {
  layout: SidebarLayoutSnapshot;
  peekDrawerHandlers: SidebarPeekHandlers;
  peekDrawerRef: React.RefObject<HTMLElement | null>;
  peekTriggerHandlers: SidebarPeekHandlers;
  resizeHandlers: SidebarResizeHandlers;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  activeProjectId?: string;
  selectedSessionId?: string;
  onOpenProject(): void;
  onCreateEmptyProject(): void;
  onSelectSession(projectId: string, sessionId: string): void;
  onLoadSessionChildren(projectId: string, parentSessionId: string, cursor?: string): Promise<DesktopSessionTreePage>;
  onSessionAction(session: DesktopSessionSummary, action: DesktopSessionMenuAction): void;
  onProjectPinned(projectId: string, pinned: boolean): void;
  onReorderProjects(projectIds: string[]): void;
  onRefreshProject(projectId: string): void;
  onRevealProject(projectId: string): void;
  onOpenTerminalProject(projectId: string): void;
  onRenameProject(projectId: string): void;
  onNewTask(projectId: string): void;
  onImportSession(projectId: string): void;
  onRemoveProject(projectId: string): void;
  onSearch(): void;
  onSettings(): void;
  onInsertCrystal(reference: string): void;
  onToggleSidebar(): void;
}

export const Sidebar = memo(function Sidebar({
  layout,
  peekDrawerHandlers,
  peekDrawerRef,
  peekTriggerHandlers,
  resizeHandlers,
  projects,
  sessions,
  activeProjectId,
  selectedSessionId,
  onOpenProject,
  onCreateEmptyProject,
  onSelectSession,
  onLoadSessionChildren,
  onSessionAction,
  onProjectPinned,
  onReorderProjects,
  onRefreshProject,
  onRevealProject,
  onOpenTerminalProject,
  onRenameProject,
  onNewTask,
  onImportSession,
  onRemoveProject,
  onSearch,
  onSettings,
  onInsertCrystal,
  onToggleSidebar
}: SidebarProps): React.JSX.Element {
  const [expandedSections, setExpandedSections] = useState<Record<SidebarSectionName, boolean>>({
    pinned: true,
    projects: true,
    dialogue: true
  });
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());
  const [loadedSessionParents, setLoadedSessionParents] = useState<Set<string>>(() => new Set());
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionNextCursors, setSessionNextCursors] = useState<Map<string, string>>(() => new Map());
  const [projectMenuOpen, setProjectMenuOpen] = useState<string>();
  const [projectOrganizationMenuOpen, setProjectOrganizationMenuOpen] = useState(false);
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ session: DesktopSessionSummary; point: { x: number; y: number } }>();
  // 关闭时数据保留在 sessionMenu 里，让退场动画期间菜单内容不消失。
  const [sessionMenuVisible, setSessionMenuVisible] = useState(false);
  const [projectSort, setProjectSort] = useState<ProjectSort>("priority");
  const [dragState, setDragState] = useState<ProjectDragState | undefined>(undefined);
  const dragStateRef = useRef<ProjectDragState | undefined>(undefined);
  const projectOrganizationButtonRef = useRef<HTMLButtonElement>(null);
  const projectCreateButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!projectMenuOpen && !projectOrganizationMenuOpen && !projectCreateMenuOpen && !sessionMenuVisible) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".biny-sidebar-menu-anchor, .biny-sidebar-menu")) return;
      setProjectMenuOpen(undefined);
      setProjectOrganizationMenuOpen(false);
      setProjectCreateMenuOpen(false);
      setSessionMenuVisible(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setProjectMenuOpen(undefined);
      setProjectOrganizationMenuOpen(false);
      setProjectCreateMenuOpen(false);
      setSessionMenuVisible(false);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectCreateMenuOpen, projectMenuOpen, projectOrganizationMenuOpen, sessionMenuVisible]);

  useEffect(() => {
    if (layout.mode !== "collapsed") return;
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setSessionMenuVisible(false);
    setDragState(undefined);
    dragStateRef.current = undefined;
  }, [layout.mode]);

  const openSessionContextMenu = useCallback((session: DesktopSessionSummary, point: { x: number; y: number }): void => {
    setProjectMenuOpen(undefined);
    setSessionMenu({ point, session });
    setSessionMenuVisible(true);
  }, []);

  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, DesktopSessionSummary[]>();
    for (const session of sessions) {
      const group = grouped.get(session.projectId) ?? [];
      group.push(session);
      grouped.set(session.projectId, group);
    }
    return grouped;
  }, [sessions]);

  const dialogueSessions = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    return sessions.filter((session) => !projectIds.has(session.projectId));
  }, [projects, sessions]);

  // 置顶区只是快捷入口；会话仍留在原项目树中，避免跨置顶状态的父子关系被拆开。
  const pinnedSessions = useMemo(() => sessions.filter((session) => session.pinned), [sessions]);

  const sessionsFor = (projectId: string): DesktopSessionSummary[] => sessionsByProject.get(projectId) ?? [];

  const orderedProjects = useMemo(() => sortProjects(projects, projectSort), [projects, projectSort]);
  const pinnedProjects = orderedProjects.filter((project) => project.pinned);
  const unpinnedProjects = orderedProjects.filter((project) => !project.pinned);
  const peekOpen = layout.mode === "peek";
  const contentVisible = layout.mode !== "collapsed";
  const compact = layout.mode === "rail";
  // 只有稳定展开态才能拖宽：rail 固定 78px，peek 是临时浮层，松手即收起。
  const resizable = layout.mode === "expanded";

  const toggleSection = (section: SidebarSectionName): void => {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  };

  const selectOrToggleProject = (projectId: string): void => {
    // 文件夹只负责浏览会话树；只有点击具体 session 行，才允许聊天区切换内容。
    if (projectId !== activeProjectId) {
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      return;
    }
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const setProjectDragState = (next: ProjectDragState | undefined): void => {
    dragStateRef.current = next;
    setDragState(next);
  };

  const beginProjectDrag = (projectId: string, section: "pinned" | "projects"): void => {
    setProjectMenuOpen(undefined);
    setProjectOrganizationMenuOpen(false);
    setProjectCreateMenuOpen(false);
    setProjectDragState({ sourceId: projectId, section });
  };

  const updateProjectDragTarget = (projectId: string, section: "pinned" | "projects", clientY: number, bounds: DOMRect): void => {
    const current = dragStateRef.current;
    if (!current || current.section !== section || current.sourceId === projectId) return;
    const placement: ProjectDragPlacement = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    if (current.targetId === projectId && current.placement === placement) return;
    setProjectDragState({ ...current, targetId: projectId, placement });
  };

  const dropProjectDrag = (targetId: string, clientY: number, bounds: DOMRect): void => {
    const current = dragStateRef.current;
    setProjectDragState(undefined);
    if (!current || current.sourceId === targetId) return;
    const placement: ProjectDragPlacement = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    const sectionProjects = current.section === "pinned" ? pinnedProjects : unpinnedProjects;
    const sectionIds = sectionProjects.map((project) => project.id);
    if (!sectionIds.includes(current.sourceId) || !sectionIds.includes(targetId)) return;
    const nextIds = reorderSectionProjectIds(
      orderedProjects.map((project) => project.id),
      sectionIds,
      current.sourceId,
      targetId,
      placement
    );
    if (nextIds.join("\0") === orderedProjects.map((project) => project.id).join("\0")) return;
    setProjectSort("manual");
    onReorderProjects(nextIds);
  };

  const projectDropClass = (projectId: string, section: "pinned" | "projects"): string => {
    if (!dragState || dragState.section !== section || dragState.targetId !== projectId || !dragState.placement) return "";
    return dragState.placement === "before" ? " is-drop-before" : " is-drop-after";
  };

  const createTask = (): void => {
    if (activeProjectId) onNewTask(activeProjectId);
    else onOpenProject();
  };

  // 置顶区有置顶会话或置顶项目时才展示。
  const showPinnedSection = Boolean(pinnedProjects.length || pinnedSessions.length);

  const loadSessionChildren = async (session: DesktopSessionSummary, cursor?: string): Promise<void> => {
    if (!session.hasChildren || loadingSessionIds.has(session.id)) return;
    setLoadingSessionIds((current) => new Set(current).add(session.id));
    try {
      const page = await onLoadSessionChildren(session.projectId, session.id, cursor);
      setLoadedSessionParents((current) => new Set(current).add(session.id));
      setSessionNextCursors((current) => {
        const next = new Map(current);
        if (page.nextCursor) next.set(session.id, page.nextCursor);
        else next.delete(session.id);
        return next;
      });
    } catch {
      // 两个调用点都是 void 调用，IPC 失败不能抛成未处理的 rejection；
      // 不写入 loadedSessionParents，用户重新展开时自然会重试。
    } finally {
      setLoadingSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  };

  const toggleSession = (session: DesktopSessionSummary): void => {
    if (!session.hasChildren) return;
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
    if (!expandedSessionIds.has(session.id) && !loadedSessionParents.has(session.id)) void loadSessionChildren(session);
  };

  const loadMoreSessionChildren = (session: DesktopSessionSummary): void => {
    const cursor = sessionNextCursors.get(session.id);
    if (cursor) void loadSessionChildren(session, cursor);
  };

  const renderProject = (project: DesktopProject, section: "pinned" | "projects"): React.JSX.Element => {
    const projectSessions = sessionsFor(project.id);
    const expanded = project.id === activeProjectId
      ? !collapsedProjectIds.has(project.id)
      : expandedProjectIds.has(project.id);
    return (
      <div
        className={`biny-project-group${dragState?.sourceId === project.id ? " is-dragging" : ""}${projectDropClass(project.id, section)}`}
        key={`${section}:${project.id}`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          updateProjectDragTarget(project.id, section, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dropProjectDrag(project.id, event.clientY, event.currentTarget.getBoundingClientRect());
        }}
      >
        <ProjectRow
          dragActive={dragState?.sourceId === project.id}
          menuOpen={projectMenuOpen === `${section}:${project.id}`}
          onDragCancel={() => setProjectDragState(undefined)}
          onDragEnd={() => setProjectDragState(undefined)}
          onDragStart={() => beginProjectDrag(project.id, section)}
          onMenu={() => {
            setProjectOrganizationMenuOpen(false);
            setProjectCreateMenuOpen(false);
            setProjectMenuOpen((current) => current === `${section}:${project.id}` ? undefined : `${section}:${project.id}`);
          }}
          onNewTask={() => { setProjectMenuOpen(undefined); onNewTask(project.id); }}
          onImportSession={() => { setProjectMenuOpen(undefined); onImportSession(project.id); }}
          onOpenTerminal={() => { setProjectMenuOpen(undefined); onOpenTerminalProject(project.id); }}
          onPin={() => { setProjectMenuOpen(undefined); onProjectPinned(project.id, !project.pinned); }}
          onRefresh={() => { setProjectMenuOpen(undefined); onRefreshProject(project.id); }}
          onRemove={() => { setProjectMenuOpen(undefined); onRemoveProject(project.id); }}
          onRename={() => { setProjectMenuOpen(undefined); onRenameProject(project.id); }}
          onReveal={() => { setProjectMenuOpen(undefined); onRevealProject(project.id); }}
          onSelect={selectOrToggleProject}
          project={project}
          selected={project.id === activeProjectId && !selectedSessionId}
          sessionsExpanded={expanded}
        />
        {/* 会话列表常驻挂载，展开/收起走高度动画；inert 保证收起后不可交互。 */}
        <Collapse open={expanded}>
          <ProjectSessions
            limit={PROJECT_SESSION_COLLAPSE_LIMIT}
            onSelectSession={onSelectSession}
            onSessionContextMenu={openSessionContextMenu}
            projectId={project.id}
            selectedSessionId={selectedSessionId}
            sessions={projectSessions}
            expandedSessionIds={expandedSessionIds}
            loadingSessionIds={loadingSessionIds}
            sessionNextCursors={sessionNextCursors}
            onToggleSession={toggleSession}
            onLoadMoreSessionChildren={loadMoreSessionChildren}
          />
        </Collapse>
      </div>
    );
  };

  return (
    <>
      {!contentVisible ? <div aria-hidden="true" className="biny-sidebar-peek-trigger" {...peekTriggerHandlers} /> : null}
      <aside
        aria-label="主导航"
        aria-hidden={contentVisible ? undefined : true}
        className={`biny-sidebar${contentVisible ? "" : " is-hidden"}${compact ? " is-compact" : ""}${layout.resizing ? " is-resizing" : ""}${peekOpen ? ` is-peek-overlay is-peek-${layout.transition === "peek-closing" ? "closing" : layout.transition === "pinning" ? "pinning" : "peeking"}` : ""}`}
        ref={peekOpen ? peekDrawerRef : undefined}
        style={{
          width: "var(--biny-sidebar-animated-visual-width)"
        }}
        onPointerEnter={peekOpen ? peekDrawerHandlers.onPointerEnter : undefined}
        onPointerLeave={peekOpen ? peekDrawerHandlers.onPointerLeave : undefined}
        onPointerMove={peekOpen ? peekDrawerHandlers.onPointerMove : undefined}
        onPointerDown={peekOpen ? peekDrawerHandlers.onPointerDown : undefined}
        onPointerUp={peekOpen ? peekDrawerHandlers.onPointerUp : undefined}
      >
        {/* 浮动卡片：aside 只负责宽度动画与裁剪，视觉壳在 card 上。 */}
        <div className="biny-sidebar-card">
          {/* 顶部行是侧栏内容的固定锚点（顶栏按钮 + 底部分割线）；收起时也保留它，避免导航内容上跳。 */}
          <div aria-hidden="true" className="biny-sidebar-topbar-spacer" />

      <div className="biny-sidebar-body">
        <div className="biny-sidebar-scroll">
          {showPinnedSection ? (
            <SidebarSection expanded={expandedSections.pinned} label="置顶" onToggle={() => toggleSection("pinned")}>
              {/* 置顶会话排在置顶文件夹之前，避免文件夹把会话顶到下面。 */}
              <SessionList
                onSelectSession={onSelectSession}
                onSessionContextMenu={openSessionContextMenu}
                    selectedSessionId={selectedSessionId}
                sessions={pinnedSessions}
                flat
                expandedSessionIds={expandedSessionIds}
                loadingSessionIds={loadingSessionIds}
                sessionNextCursors={sessionNextCursors}
                onToggleSession={toggleSession}
                onLoadMoreSessionChildren={loadMoreSessionChildren}
              />
              {pinnedProjects.map((project) => renderProject(project, "pinned"))}
            </SidebarSection>
          ) : null}

          <SidebarSection
            actions={(
              <div className="biny-sidebar-section-actions biny-sidebar-menu-anchor">
                <button
                  ref={projectOrganizationButtonRef}
                  aria-expanded={projectOrganizationMenuOpen}
                  aria-haspopup="menu"
                  aria-label="项目排序"
                  className="biny-sidebar-section-action"
                  onClick={() => {
                    setProjectMenuOpen(undefined);
                    setProjectCreateMenuOpen(false);
                    setProjectOrganizationMenuOpen((current) => !current);
                  }}
                  title="项目排序"
                  type="button"
                >
                  <Icon name="more" size={14} />
                </button>
                <button
                  ref={projectCreateButtonRef}
                  aria-expanded={projectCreateMenuOpen}
                  aria-haspopup="menu"
                  aria-label="添加项目"
                  className="biny-sidebar-section-action"
                  onClick={() => {
                    setProjectMenuOpen(undefined);
                    setProjectOrganizationMenuOpen(false);
                    setProjectCreateMenuOpen((current) => !current);
                  }}
                  title="添加项目"
                  type="button"
                >
                  <Icon name="add" size={14} />
                </button>
                <SidebarOrganizationMenu
                  anchorRef={projectOrganizationButtonRef}
                  onSortChange={(value) => { setProjectSort(value); setProjectOrganizationMenuOpen(false); }}
                  open={projectOrganizationMenuOpen}
                  sort={projectSort}
                />
                <SidebarCreationMenu
                  anchorRef={projectCreateButtonRef}
                  onCreateEmptyProject={() => { setProjectCreateMenuOpen(false); onCreateEmptyProject(); }}
                  onOpenProject={() => { setProjectCreateMenuOpen(false); onOpenProject(); }}
                  open={projectCreateMenuOpen}
                />
              </div>
            )}
            expanded={expandedSections.projects}
            icon="folder"
            label="项目"
            onToggle={() => toggleSection("projects")}
          >
            {unpinnedProjects.map((project) => renderProject(project, "projects"))}
            {!unpinnedProjects.length ? <div className="biny-sidebar-empty-row">暂无项目，点击 + 添加</div> : null}
          </SidebarSection>

          {dialogueSessions.length > 0 ? <SidebarSection expanded={expandedSections.dialogue} icon="message" label="对话" onToggle={() => toggleSection("dialogue")}>
            <CollapsibleSessionList
              limit={DIALOGUE_SESSION_COLLAPSE_LIMIT}
              onSelectSession={onSelectSession}
              onSessionContextMenu={openSessionContextMenu}
                selectedSessionId={selectedSessionId}
              sessions={dialogueSessions}
              expandedSessionIds={expandedSessionIds}
              loadingSessionIds={loadingSessionIds}
              sessionNextCursors={sessionNextCursors}
              onToggleSession={toggleSession}
              onLoadMoreSessionChildren={loadMoreSessionChildren}
            />
          </SidebarSection> : null}
        </div>
      </div>

      <div className="biny-sidebar-footer">
        <button aria-label="设置" className="biny-sidebar-settings-item" onClick={onSettings} title="设置" type="button">
          <Icon name="settings" size={16} />
          <span>设置</span>
        </button>
        <CrystalDock sessionId={selectedSessionId} onInsert={onInsertCrystal} />
        <DiaryDock />
      </div>
      </div>
      {resizable ? <SidebarResizer width={layout.contentWidth} {...resizeHandlers} /> : null}
      </aside>
      <SessionContextMenu
        menu={sessionMenu}
        onAction={(action) => {
          setSessionMenuVisible(false);
          if (sessionMenu) onSessionAction(sessionMenu.session, action);
        }}
        open={sessionMenuVisible}
      />
      <SidebarChrome
        collapsed={!contentVisible}
        floating
        onNewTask={createTask}
        onSearch={onSearch}
        onToggle={onToggleSidebar}
      />
    </>
  );
});

function SidebarChrome({ collapsed, floating = false, onNewTask, onSearch, onToggle }: { collapsed: boolean; floating?: boolean; onNewTask(): void; onSearch(): void; onToggle(): void }): React.JSX.Element {
  return (
    <>
      <div className={`biny-sidebar-topbar${floating ? " biny-sidebar-topbar-floating" : ""}`}>
        <div className={floating ? "biny-sidebar-topbar-hit-layer" : undefined}>
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            className="biny-chrome-button"
            onClick={onToggle}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            type="button"
          >
            <Icon name="sidebar" size={15} />
          </button>
          <button
            aria-label="搜索"
            className="biny-chrome-button"
            onClick={onSearch}
            title="搜索"
            type="button"
          >
            <Icon name="search" size={15} />
          </button>
          <button
            aria-label="新建任务"
            className="biny-chrome-button"
            onClick={onNewTask}
            title="新建任务"
            type="button"
          >
            <Icon name="compose" size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 侧栏右缘拖拽把手。拖拽中把宽度实时夹在上下限内交给上层；到达边界后指针继续
 * 移动也不再改变宽度，松手时再提交最终宽度。
 */
function SidebarResizer({ width, onResizeStart, onWidthChange, onResizeEnd }: { width: number } & SidebarResizeHandlers): React.JSX.Element {
  const resizeWithKeyboard = (direction: -1 | 1): void => {
    const next = clampSidebarWidth(width + direction * 16);
    onWidthChange(next);
    onResizeEnd(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizeStart();
    const startX = event.clientX;
    const startWidth = width;
    let currentWidth = startWidth;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      currentWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      onWidthChange(currentWidth);
    };
    const stop = (): void => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      onResizeEnd(currentWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuenow={Math.round(width)}
      className="biny-sidebar-resizer"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(-1); }
        if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(1); }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    />
  );
}

function SidebarSection({ label, icon, expanded, actions, onToggle, children }: { label: string; icon?: IconName; expanded: boolean; actions?: React.ReactNode; onToggle(): void; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-label={label} className={`biny-sidebar-section${expanded ? " is-expanded" : ""}${icon ? " has-compact-icon" : ""}`}>
      <div className="biny-sidebar-section-header">
        <button aria-expanded={expanded} aria-label={label} className="biny-sidebar-section-trigger" onClick={onToggle} type="button">
          {icon ? <span aria-hidden="true" className="biny-sidebar-section-icon"><Icon name={icon} size={16} /></span> : null}
          <span className="biny-sidebar-section-label">{label}</span>
          <span className="biny-sidebar-section-chevron"><Icon name="chevron" size={13} /></span>
        </button>
        {actions}
      </div>
      <div className="biny-sidebar-section-content"><div>{children}</div></div>
    </section>
  );
}

function ProjectSessions({ projectId, sessions, selectedSessionId, onSelectSession, onSessionContextMenu, flat = false, limit = PROJECT_SESSION_COLLAPSE_LIMIT, expandedSessionIds, loadingSessionIds, sessionNextCursors, onToggleSession, onLoadMoreSessionChildren }: { projectId: string; sessions: DesktopSessionSummary[]; selectedSessionId?: string; onSelectSession(projectId: string, sessionId: string): void; onSessionContextMenu(session: DesktopSessionSummary, point: { x: number; y: number }): void; flat?: boolean; limit?: number; expandedSessionIds: Set<string>; loadingSessionIds: Set<string>; sessionNextCursors: Map<string, string>; onToggleSession(session: DesktopSessionSummary): void; onLoadMoreSessionChildren(session: DesktopSessionSummary): void }): React.JSX.Element | null {
  if (!sessions.length) return <div className="biny-sidebar-empty-row biny-sidebar-project-empty">没有聊天</div>;
  return (
    <CollapsibleSessionList
      limit={limit}
      flat={flat}
      onSelectSession={onSelectSession}
      onSessionContextMenu={onSessionContextMenu}
      projectId={projectId}
      selectedSessionId={selectedSessionId}
      sessions={sessions}
      expandedSessionIds={expandedSessionIds}
      loadingSessionIds={loadingSessionIds}
      sessionNextCursors={sessionNextCursors}
      onToggleSession={onToggleSession}
      onLoadMoreSessionChildren={onLoadMoreSessionChildren}
    />
  );
}

interface SessionListProps {
  flat?: boolean;
  projectId?: string;
  sessions: DesktopSessionSummary[];
  selectedSessionId?: string;
  onSelectSession(projectId: string, sessionId: string): void;
  onSessionContextMenu(session: DesktopSessionSummary, point: { x: number; y: number }): void;
  expandedSessionIds: Set<string>;
  loadingSessionIds: Set<string>;
  sessionNextCursors: Map<string, string>;
  onToggleSession(session: DesktopSessionSummary): void;
  onLoadMoreSessionChildren(session: DesktopSessionSummary): void;
}

function CollapsibleSessionList({ limit, ...props }: SessionListProps & { limit: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = props.sessions.length > limit;
  useEffect(() => {
    if (!shouldCollapse) setExpanded(false);
  }, [shouldCollapse]);
  const visibleSessions = expanded ? props.sessions : props.sessions.slice(0, limit);
  return (
    <>
      <SessionList {...props} sessions={visibleSessions} />
      {shouldCollapse ? (
        <button className="biny-sidebar-session-expand" onClick={() => setExpanded((current) => !current)} type="button">
          {expanded ? "收起" : "显示更多"}
        </button>
      ) : null}
    </>
  );
}

function SessionList({ flat = false, projectId, sessions, selectedSessionId, onSelectSession, onSessionContextMenu, expandedSessionIds, loadingSessionIds, sessionNextCursors, onToggleSession, onLoadMoreSessionChildren }: SessionListProps): React.JSX.Element {
  const byParent = new Map<string | undefined, DesktopSessionSummary[]>();
  const ids = new Set(sessions.map((session) => session.id));
  for (const session of sessions) {
    const parent = !flat && session.parentSessionId && ids.has(session.parentSessionId) ? session.parentSessionId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(session);
    byParent.set(parent, siblings);
  }
  // Fluid Functionalism 悬停：列表容器是指针作用域和定位上下文，行背景由
  // FluidHoverHighlight 统一绘制；注册索引即可见行的渲染顺序。
  // 收起的子会话树仍保持挂载（保住高度退场动画），inert 行对命中测试隐藏。
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef, {
    isItemDisabled: (element) => element.closest("[inert]") !== null
  });
  // 子会话仍通过折叠容器表达从属关系，但标题列保持统一，避免同一列表中
  // 仅因父子关系让可用宽度忽长忽短。
  let rowIndex = 0;
  const renderNode = (session: DesktopSessionSummary, ancestors: Set<string>): React.JSX.Element[] => {
    if (ancestors.has(session.id)) return [];
    const nextAncestors = new Set(ancestors).add(session.id);
    const expandable = !flat && Boolean(session.hasChildren);
    const expanded = expandable && expandedSessionIds.has(session.id);
    const loading = expandable && loadingSessionIds.has(session.id);
    // 子树常驻挂在 Collapse 里，收起是收放高度而不是卸载；未懒加载过的父节点
    // 没有子行，首次展开时 Collapse 已在（open 从一开始就过渡），内容随数据到位撑开。
    const children = (byParent.get(session.id) ?? []).flatMap((child) => renderNode(child, nextAncestors));
    const nextCursor = sessionNextCursors.get(session.id);
    return [
      <SessionTreeRow
        expandable={expandable}
        expanded={expanded}
        index={rowIndex++}
        key={`${session.projectId}:${session.id}`}
        loading={loading}
        onContextMenu={onSessionContextMenu}
        onSelect={onSelectSession}
        onToggle={onToggleSession}
        projectId={projectId}
        registerItem={hover.registerItem}
        selected={session.id === selectedSessionId}
        session={session}
      />,
      ...(expandable ? [
        <Collapse className="biny-sidebar-session-children" key={`${session.projectId}:${session.id}:tree`} open={expanded}>
          {children}
          {nextCursor ? (
            <button className="biny-sidebar-session-expand" onClick={() => onLoadMoreSessionChildren(session)} type="button">
              显示更多
            </button>
          ) : null}
        </Collapse>
      ] : [])
    ];
  };
  return (
    <div ref={listRef} className={`biny-sidebar-session-list${projectId ? " is-indented" : ""}`} {...hover.handlers}>
      <FluidHoverHighlight hover={hover} className="has-row-radius" />
      {(byParent.get(undefined) ?? []).flatMap((session) => renderNode(session, new Set()))}
    </div>
  );
}

// 会话行。注册必须走 useRegisterFluidHoverItem（内部是依赖稳定的 useEffect）：
// 内联 ref 回调会在每次渲染时先注销再注册，hook 的“高亮行被注销”分支会把
// 点亮状态立刻清掉，高亮永远出不来，因此行拆成独立组件。
function SessionTreeRow({
  expandable,
  expanded,
  index,
  loading,
  projectId,
  registerItem,
  selected,
  session,
  onContextMenu,
  onSelect,
  onToggle
}: {
  expandable: boolean;
  expanded: boolean;
  index: number;
  loading: boolean;
  projectId: string | undefined;
  registerItem: UseFluidHoverReturn["registerItem"];
  selected: boolean;
  session: DesktopSessionSummary;
  onContextMenu(session: DesktopSessionSummary, point: { x: number; y: number }): void;
  onSelect(projectId: string, sessionId: string): void;
  onToggle(session: DesktopSessionSummary): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  const running = isSessionRunning(session);
  const title = session.title || session.firstUserMessage || "新对话";
  // 运行中时右侧位置让给 spinner，不再显示相对时间。
  const meta = running ? undefined : sidebarSessionMeta(session);
  const metaTitle = meta ? sidebarSessionUpdatedAt(session.updatedAt) : undefined;
  const worktree = session.isolation === "worktree";
  const accessibleLabel = worktree
    ? [title, "Git 工作树", metaTitle].filter((value): value is string => Boolean(value)).join(" · ")
    : undefined;
  return (
    <div ref={ref} className={`biny-sidebar-session-tree-row${selected ? " is-selected" : ""}`} data-worktree={worktree ? "true" : undefined}>
      <button
        aria-expanded={expandable ? expanded : undefined}
        aria-label={expandable ? (expanded ? "收起子会话" : "展开子会话") : undefined}
        className={`biny-sidebar-session-toggle${expandable ? "" : " is-empty"}`}
        disabled={!expandable || loading}
        onClick={() => onToggle(session)}
        type="button"
      >
        {loading ? "…" : expandable ? <Icon name="chevron" size={12} /> : null}
      </button>
      <div className={`biny-sidebar-session-entry${selected ? " is-selected" : ""}${session.archived ? " is-archived" : ""}`}>
        <button
          aria-current={selected ? "page" : undefined}
          aria-label={accessibleLabel}
          className="biny-sidebar-session-item"
          onClick={() => onSelect(projectId ?? session.projectId, session.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu(session, { x: event.clientX, y: event.clientY });
          }}
          title={session.title}
          type="button"
        >
          <span className="biny-sidebar-session-line">
            {session.pinned ? <span aria-hidden="true" className="biny-sidebar-session-pin"><Icon name="pin" size={12} /></span> : session.unread ? <span aria-label="未读" className="biny-sidebar-session-unread" /> : null}
            <span className="biny-sidebar-session-title">{title}</span>
            {running ? <WorkingIndicator waiting={session.status === "waiting_permission"} /> : meta && metaTitle ? <span aria-label={`上次活动：${metaTitle}`} className="biny-sidebar-session-meta" title={metaTitle}>{meta}</span> : null}
          </span>
        </button>
      </div>
    </div>
  );
}

const ProjectRow = memo(function ProjectRow({
  project,
  selected,
  sessionsExpanded,
  dragActive,
  menuOpen,
  onSelect,
  onMenu,
  onNewTask,
  onImportSession,
  onPin,
  onRefresh,
  onReveal,
  onOpenTerminal,
  onRename,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragCancel
}: {
  project: DesktopProject;
  selected: boolean;
  sessionsExpanded: boolean;
  dragActive: boolean;
  menuOpen: boolean;
  onSelect(projectId: string): void;
  onMenu(): void;
  onNewTask(): void;
  onImportSession(): void;
  onPin(): void;
  onRefresh(): void;
  onReveal(): void;
  onOpenTerminal(): void;
  onRename(): void;
  onRemove(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragCancel(): void;
}): React.JSX.Element {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  return (
    <div
      className={`biny-project-row-wrap${selected ? " is-active" : ""}${sessionsExpanded ? " is-expanded" : ""}${dragActive ? " is-drag-active" : ""}`}
      draggable
      onDragEnd={(event) => {
        event.preventDefault();
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        onDragEnd();
      }}
      onDragStart={(event) => {
        if (event.target instanceof Element && event.target.closest(".biny-project-row-actions")) {
          event.preventDefault();
          return;
        }
        suppressClickRef.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", project.id);
        onDragStart();
      }}
      onKeyDown={(event) => { if (event.key === "Escape" && dragActive) onDragCancel(); }}
    >
      <div
        aria-expanded={sessionsExpanded}
        className={`biny-project-row${selected ? " is-active" : ""}`}
        onClick={() => { if (!suppressClickRef.current) onSelect(project.id); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect(project.id);
        }}
        title={project.path}
        role="button"
        tabIndex={0}
      >
        <Icon name={sessionsExpanded ? "folder-open" : "folder"} size={16} />
        <span className="biny-project-row-label">{project.name}</span>
        {project.missing ? <span className="biny-project-status is-failed" title="路径不可用" /> : null}
      </div>
      <div className={`biny-project-row-actions${menuOpen ? " is-open" : ""} biny-sidebar-menu-anchor`}>
        <button aria-label={`新建任务 ${project.name}`} className="biny-project-row-action" onClick={onNewTask} title="新建任务" type="button"><Icon name="compose" size={14} /></button>
        <button ref={menuButtonRef} aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`${project.name} 项目操作`} className="biny-project-row-action" onClick={onMenu} title="项目操作" type="button"><Icon name="more" size={14} /></button>
        <ProjectMenu anchorRef={menuButtonRef} onImportSession={onImportSession} onOpenTerminal={onOpenTerminal} onPin={onPin} onRefresh={onRefresh} onRemove={onRemove} onRename={onRename} onReveal={onReveal} open={menuOpen} project={project} />
      </div>
    </div>
  );
});

function ProjectMenu({ anchorRef, project, open, onPin, onRefresh, onReveal, onOpenTerminal, onRename, onRemove, onImportSession }: { anchorRef: FloatingMenuAnchor; project: DesktopProject; open: boolean; onPin(): void; onRefresh(): void; onReveal(): void; onOpenTerminal(): void; onRename(): void; onRemove(): void; onImportSession(): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="项目操作菜单" open={open}>
      <button onClick={onPin} role="menuitem" type="button"><Icon name="pin" size={15} /><span>{project.pinned ? "取消置顶项目" : "置顶项目"}</span></button>
      <button onClick={onImportSession} role="menuitem" type="button"><Icon name="download" size={15} /><span>导入会话…</span></button>
      <button onClick={onRefresh} role="menuitem" type="button"><Icon name="refresh" size={15} /><span>刷新项目状态</span></button>
      <button onClick={onReveal} role="menuitem" type="button"><Icon name="external" size={15} /><span>在 Finder 中显示</span></button>
      <button onClick={onOpenTerminal} role="menuitem" type="button"><Icon name="terminal" size={15} /><span>在终端中打开</span></button>
      <button onClick={onRename} role="menuitem" type="button"><Icon name="edit" size={15} /><span>重命名项目</span></button>
      <div className="biny-sidebar-menu-separator" />
      <button className="is-danger" onClick={onRemove} role="menuitem" type="button"><Icon name="trash" size={15} /><span>移除项目</span></button>
    </FloatingSidebarMenu>
  );
}

/** 会话右键菜单：替代原先由主进程弹出的原生菜单，样式与侧栏其余菜单保持一致。 */
function SessionContextMenu({ menu, onAction, open }: { menu?: { session: DesktopSessionSummary; point: { x: number; y: number } }; onAction(action: DesktopSessionMenuAction): void; open: boolean }): React.JSX.Element | null {
  if (!menu) return null;
  const { session } = menu;
  return (
    <FloatingSidebarMenu ariaLabel="会话操作菜单" open={open} point={menu.point}>
      <button onClick={() => onAction("rename")} role="menuitem" type="button"><Icon name="edit" size={15} /><span>重命名</span></button>
      <button onClick={() => onAction(session.pinned ? "unpin" : "pin")} role="menuitem" type="button"><Icon name="pin" size={15} /><span>{session.pinned ? "取消置顶" : "置顶"}</span></button>
      <button onClick={() => onAction(session.archived ? "unarchive" : "archive")} role="menuitem" type="button"><Icon name="archive" size={15} /><span>{session.archived ? "取消归档" : "归档"}</span></button>
      <button onClick={() => onAction("duplicate")} role="menuitem" type="button"><Icon name="copy" size={15} /><span>复制会话</span></button>
      <div className="biny-sidebar-menu-separator" />
      <button onClick={() => onAction("export-bundle")} role="menuitem" type="button"><Icon name="download" size={15} /><span>导出会话包…</span></button>
      <button onClick={() => onAction("export-claude")} role="menuitem" type="button"><Icon name="download" size={15} /><span>导出为 Claude Code…</span></button>
      <div className="biny-sidebar-menu-separator" />
      <button className="is-danger" onClick={() => onAction("delete")} role="menuitem" type="button"><Icon name="trash" size={15} /><span>删除</span></button>
    </FloatingSidebarMenu>
  );
}

function SidebarOrganizationMenu({ anchorRef, open, sort, onSortChange }: { anchorRef: FloatingMenuAnchor; open: boolean; sort: ProjectSort; onSortChange(value: ProjectSort): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="项目排序菜单" className="is-narrow" open={open}>
      <div className="biny-sidebar-menu-heading">排序方式</div>
      {([
        ["priority", "优先级"],
        ["recent", "最近打开"],
        ["manual", "手动排序"]
      ] as const).map(([value, label]) => (
        <button aria-checked={sort === value} key={value} onClick={() => onSortChange(value)} role="menuitemradio" type="button">
          <span className="biny-sidebar-menu-check">{sort === value ? <Icon name="check" size={14} /> : null}</span>
          <span>{label}</span>
        </button>
      ))}
    </FloatingSidebarMenu>
  );
}

function SidebarCreationMenu({ anchorRef, open, onCreateEmptyProject, onOpenProject }: { anchorRef: FloatingMenuAnchor; open: boolean; onCreateEmptyProject(): void; onOpenProject(): void }): React.JSX.Element {
  return (
    <FloatingSidebarMenu anchorRef={anchorRef} ariaLabel="添加项目菜单" open={open}>
      <button onClick={onCreateEmptyProject} role="menuitem" type="button"><Icon name="add" size={15} /><span>新建空项目</span></button>
      <button onClick={onOpenProject} role="menuitem" type="button"><Icon name="folder" size={15} /><span>使用现有文件夹</span></button>
    </FloatingSidebarMenu>
  );
}

function FloatingSidebarMenu({ anchorRef, ariaLabel, className = "", children, open, point }: { /** 省略 anchorRef 时必须提供 point，按指针坐标定位（右键菜单）。 */ anchorRef?: FloatingMenuAnchor; ariaLabel: string; className?: string; children: React.ReactNode; open: boolean; point?: { x: number; y: number } }): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; origin: "top-left" | "bottom-left" }>();

  useLayoutEffect(() => {
    if (!presence.present) return;
    let frame: number | undefined;
    const updatePosition = (): void => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        const anchor = anchorRef?.current;
        const surface = surfaceRef.current;
        if (!anchor && !point) return;
        if (!surface) return;
        // 坐标定位时构造一个以指针为锚点的虚拟矩形，复用同一套翻转与视口收拢逻辑。
        const rect = point
          ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
          : anchor!.getBoundingClientRect();
        const width = surface.offsetWidth || (className === "is-narrow" ? 166 : 238);
        const height = surface.offsetHeight;
        const viewportPadding = 8;
        const gap = 6;
        const roomBelow = window.innerHeight - rect.bottom - gap;
        const roomAbove = rect.top - gap;
        const placeAbove = roomBelow < height && roomAbove > roomBelow;
        const left = Math.min(Math.max(viewportPadding, rect.left), Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
        const top = placeAbove
          ? Math.max(viewportPadding, rect.top - height - gap)
          : Math.min(rect.bottom + gap, Math.max(viewportPadding, window.innerHeight - height - viewportPadding));
        const origin = placeAbove ? "bottom-left" : "top-left";
        setPosition((current) => current?.left === left && current.top === top && current.origin === origin
          ? current
          : { left, top, origin });
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    if (anchorRef?.current) resizeObserver?.observe(anchorRef.current);
    if (surfaceRef.current) resizeObserver?.observe(surfaceRef.current);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, className, point, presence.present]);

  if (!presence.present) return null;
  return createPortal(
    <div aria-label={ariaLabel} className={`biny-sidebar-menu${className ? ` ${className}` : ""}`} data-menu-phase={presence.phase} data-origin={position?.origin ?? "top-left"} ref={surfaceRef} role="menu" style={{ left: position?.left, top: position?.top, visibility: position ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body
  );
}

function sortProjects(projects: DesktopProject[], sort: ProjectSort): DesktopProject[] {
  const ordered = [...projects];
  if (sort === "manual") return ordered;
  if (sort === "priority") return ordered.sort((left, right) => left.pinned === right.pinned ? 0 : left.pinned ? -1 : 1);
  return ordered.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.name.localeCompare(right.name));
}

function reorderSectionProjectIds(fullIds: string[], sectionIds: string[], sourceId: string, targetId: string, placement: ProjectDragPlacement): string[] {
  const nextSection = sectionIds.filter((projectId) => projectId !== sourceId);
  const targetIndex = nextSection.indexOf(targetId);
  if (targetIndex < 0) return fullIds;
  nextSection.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  const sectionMembers = new Set(sectionIds);
  let sectionIndex = 0;
  return fullIds.map((projectId) => sectionMembers.has(projectId) ? nextSection[sectionIndex++]! : projectId);
}

function isSessionRunning(session: DesktopSessionSummary): boolean {
  return session.status === "running" || session.status === "waiting_permission";
}

/** 会话右侧只保留相对时间；运行中时该位置由 WorkingIndicator 占据。悬停标题提供完整时间。 */
function sidebarSessionMeta(session: DesktopSessionSummary): string | undefined {
  const updatedAt = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAt)) return undefined;
  const elapsedMs = Math.max(0, Date.now() - updatedAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} 天`;
  const date = new Date(updatedAt);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function sidebarSessionUpdatedAt(value: string): string {
  const updatedAt = Date.parse(value);
  if (!Number.isFinite(updatedAt)) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(updatedAt));
}
