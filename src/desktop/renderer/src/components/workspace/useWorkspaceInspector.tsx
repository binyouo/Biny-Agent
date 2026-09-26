/* eslint-disable react-refresh/only-export-components -- Inspector 请求状态与私有视图必须共享同一生命周期。 */
/** 文件详情与工作区工具的并排面板；产出菜单独立于面板开合状态。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopWorkspaceDirectory, DesktopWorkspaceFilePreview } from "../../../../protocol.js";
import {
  clampFilePanelWidth,
  MAX_FILE_PANEL_WIDTH,
  MIN_FILE_PANEL_WIDTH
} from "../../../../filePanelSizing.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import type { SessionFileChange } from "../../sessionChanges.js";
import type { LocalReferenceResult } from "../../../../../session/localReferences.js";
import { WorkspaceBrowserPanel } from "./WorkspaceBrowserPanel.js";
import { WorkspaceCommitPanel } from "./WorkspaceCommitPanel.js";
import { WorkspaceReferencesPanel } from "./WorkspaceReferencesPanel.js";
import { WorkspaceRailButton } from "./WorkspaceRailButton.js";
import { Icon, type IconName } from "../Icon.js";
import { TerminalView } from "../TerminalView.js";
import { FilePreviewPanel, type FileDirectoryState, type FilePreviewState } from "./FilePreviewPanel.js";
import { SessionChangesPanel } from "./SessionChangesPanel.js";
import { WorkspaceToolsPanel } from "./WorkspaceUtilityPanels.js";

interface UseWorkspaceInspectorOptions {
  /** 当前会话 Agent 改过的文件（「变更」视图数据 + tab/rail 徽标计数）。 */
  changes: SessionFileChange[];
  tools: TimelineTool[];
  filePanelResizing: boolean;
  filePanelWidth: number;
  /** 左栏目标占位宽度；动画中的每帧宽度不得回传为 React 状态。 */
  sidebarFlowWidth?: number;
  projectId?: string;
  source: string;
  onFilePanelResizeEnd(width: number): void;
  onFilePanelResizeStart(): void;
  onFilePanelWidthChange(width: number): void;
  onListDirectory(path: string): Promise<DesktopWorkspaceDirectory>;
  onOpenFile(path: string): void;
  onOpenBrowser(): Promise<void>;
  onFixPreview(error: string): void;
  onAttachBrowserReference?(reference: LocalReferenceResult): void;
  onSwitchBranch(projectId: string, branch: string): Promise<void>;
  onReadFile(path: string): Promise<DesktopWorkspaceFilePreview>;
  /** rail 动作（浏览器打开等）失败的提示通道。 */
  onWarning(message: string): void;
}

type InspectorView = "files" | "changes" | "commit" | "terminal" | "browser" | "tools" | "references";

const inspectorViewMetadata: Record<InspectorView, { icon: IconName; label: string }> = {
  files: { icon: "list-tree", label: "文件" },
  changes: { icon: "file-diff", label: "变更" },
  commit: { icon: "commit", label: "提交" },
  terminal: { icon: "terminal", label: "终端" },
  browser: { icon: "globe", label: "浏览器" },
  tools: { icon: "wrench", label: "工具" },
  references: { icon: "search", label: "引用" }
};

/** 所有面板入口只切换视图，模型任务由面板中的明确操作触发。 */
type RailAction = InspectorView | "browser";

const inspectorViews = Object.keys(inspectorViewMetadata) as InspectorView[];

export function useWorkspaceInspector({
  changes,
  tools,
  filePanelResizing,
  filePanelWidth,
  sidebarFlowWidth = 0,
  projectId,
  source,
  onFilePanelResizeEnd,
  onFilePanelResizeStart,
  onFilePanelWidthChange,
  onListDirectory,
  onOpenFile,
  onOpenBrowser,
  onFixPreview,
  onAttachBrowserReference,
  onSwitchBranch,
  onReadFile,
  onWarning
}: UseWorkspaceInspectorOptions): {
  dock?: React.JSX.Element;
  rail?: React.JSX.Element;
  layout: {
    open: boolean;
    focused?: boolean;
    resizing: boolean;
    width: number;
  };
  filesOpen: boolean;
  terminalOpen: boolean;
  openFiles(): void;
  showBrowser(): void;
  previewFile(path: string): void;
  previewReference(reference: LocalReferenceResult): void;
  toggleTerminal(): void;
} {
  const previewRequestRef = useRef(0);
  const directoryRequestIdRef = useRef(0);
  const directoryRequestRef = useRef(new Map<string, number>());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const previousSource = useRef({ source, projectId });
  const [visitedViews, setVisitedViews] = useState<Set<InspectorView>>(() => new Set());
  const [compactTabs, setCompactTabs] = useState(false);
  const tabStripRef = useRef<HTMLElement>(null);
  const tabMeasureRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const availableWidth = Math.max(0, viewportWidth - sidebarFlowWidth);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("files");
  const focused = browserExpanded && inspectorView === "browser" && inspectorOpen;
  // 右栏只能使用聊天区之外的空间；保留用户拖拽宽度作为偏好，不把临时收窄写回设置。
  const panelWidth = focused ? availableWidth : Math.min(filePanelWidth, Math.max(0, Math.min(availableWidth * 0.45, availableWidth - 360)));
  const [gitChangeCount, setGitChangeCount] = useState<number>();
  const [reference, setReference] = useState<LocalReferenceResult>();
  const [preview, setPreview] = useState<FilePreviewState>();
  const [directoryStates, setDirectoryStates] = useState<Map<string, FileDirectoryState>>(new Map());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const effectiveOpen = inspectorOpen && Boolean(projectId);
  const activePreview = preview?.source === source ? preview : undefined;

  useLayoutEffect(() => {
    const previous = previousSource.current;
    if (previous.source === source && previous.projectId === projectId) return;
    previousSource.current = { source, projectId };
    const projectChanged = previous.projectId !== projectId;
    if (projectChanged) { setPinned(false); setGitChangeCount(undefined); }
    previewRequestRef.current += 1;
    directoryRequestIdRef.current += 1;
    directoryRequestRef.current.clear();
    if (projectChanged || !pinned) setInspectorOpen(false);
    setPreview(undefined);
    setReference(undefined);
    setDirectoryStates(new Map());
    setExpandedDirectories(new Set());
  }, [pinned, projectId, source]);

  const loadDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const requestId = directoryRequestIdRef.current + 1;
    directoryRequestIdRef.current = requestId;
    directoryRequestRef.current.set(normalizedPath, requestId);
    setDirectoryStates((current) => {
      const next = new Map(current);
      next.set(normalizedPath, { status: "loading" });
      return next;
    });
    void onListDirectory(normalizedPath).then((directory) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizeWorkspacePath(directory.path), { status: "ready", entries: directory.entries });
        return next;
      });
    }).catch((error: unknown) => {
      if (directoryRequestRef.current.get(normalizedPath) !== requestId) return;
      setDirectoryStates((current) => {
        const next = new Map(current);
        next.set(normalizedPath, { status: "error", error: errorMessage(error) });
        return next;
      });
    });
  }, [onListDirectory]);

  const openInspector = useCallback((view: InspectorView): void => {
    if (!projectId) return;
    setInspectorView(view);
    setVisitedViews((current) => new Set(current).add(view));
    setInspectorOpen(true);
    if (view === "files" && !directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, projectId]);

  const openFiles = useCallback((): void => {
    openInspector("files");
  }, [openInspector]);

  const showBrowser = useCallback((): void => openInspector("browser"), [openInspector]);
  const previewReference = useCallback((value: LocalReferenceResult): void => {
    setReference(value);
    openInspector("references");
  }, [openInspector]);

  const toggleTerminal = useCallback((): void => {
    if (inspectorOpen && inspectorView === "terminal") {
      setInspectorOpen(false);
      return;
    }
    openInspector("terminal");
  }, [inspectorOpen, inspectorView, openInspector]);

  const previewFile = useCallback((path: string): void => {
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setInspectorView("files");
    setVisitedViews((current) => new Set(current).add("files"));
    setInspectorOpen(true);
    setPreview({ source, path, status: "loading", file: undefined, error: undefined });
    void onReadFile(path).then((file) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path: file.path, status: "ready", file, error: undefined });
    }).catch((error: unknown) => {
      if (previewRequestRef.current !== request) return;
      setPreview({ source, path, status: "error", file: undefined, error: errorMessage(error) });
    });
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory, onReadFile, source]);

  const showFileBrowser = useCallback((): void => {
    previewRequestRef.current += 1;
    setPreview(undefined);
    if (!directoryStates.has(".")) loadDirectory(".");
  }, [directoryStates, loadDirectory]);

  const toggleDirectory = useCallback((relativePath: string): void => {
    const normalizedPath = normalizeWorkspacePath(relativePath);
    const willExpand = !expandedDirectories.has(normalizedPath);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (willExpand) next.add(normalizedPath);
      else next.delete(normalizedPath);
      return next;
    });
    const state = directoryStates.get(normalizedPath);
    if (willExpand && (!state || state.status === "error")) loadDirectory(normalizedPath);
  }, [directoryStates, expandedDirectories, loadDirectory]);

  const openBrowser = useCallback((): void => {
    void onOpenBrowser().catch((error: unknown) => onWarning(errorMessage(error)));
  }, [onOpenBrowser, onWarning]);

  const openRailAction = useCallback((action: RailAction): void => {
    // rail 上点当前已打开的 tab 再点一次是收起面板。
    if (inspectorOpen && inspectorView === action) {
      setInspectorOpen(false);
      return;
    }
    openInspector(action);
  }, [inspectorOpen, inspectorView, openInspector]);

  useEffect(() => {
    if (!projectId) return;
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isTextEntryTarget(event.target) || !event.metaKey) return;
      if (event.shiftKey && !event.altKey && event.code === "KeyG") {
        event.preventDefault();
        openRailAction("commit");
        return;
      }
      if (event.shiftKey && !event.altKey && event.code === "KeyD") {
        event.preventDefault();
        openRailAction("changes");
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyT") {
        event.preventDefault();
        openBrowser();
        return;
      }
      if (!event.shiftKey && !event.altKey && event.code === "KeyP") {
        event.preventDefault();
        openRailAction("files");
        return;
      }
      if (!event.shiftKey && event.altKey && event.code === "KeyS") {
        event.preventDefault();
        openRailAction("tools");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openBrowser, openRailAction, projectId]);

  const refreshFiles = (): void => {
    loadDirectory(".");
    for (const path of expandedDirectories) loadDirectory(path);
    if (activePreview) previewFile(activePreview.path);
  };
  const toolContent = (view: InspectorView): React.JSX.Element | null => !projectId ? null : view === "terminal" ? <TerminalView projectId={projectId} active={inspectorOpen && inspectorView === "terminal"} />
    : view === "files" ? <FilePreviewPanel directoryStates={directoryStates} expandedDirectories={expandedDirectories} onOpenFile={onOpenFile} onPreviewFile={previewFile} onShowFiles={showFileBrowser} onToggleDirectory={toggleDirectory} preview={activePreview} projectId={projectId} onRefresh={refreshFiles} onCollapse={() => setExpandedDirectories(new Set())} />
      : view === "changes" ? <SessionChangesPanel changes={changes} onPreviewFile={previewFile} />
        : view === "commit" ? <WorkspaceCommitPanel projectId={projectId} active={effectiveOpen && inspectorView === "commit"} onCount={setGitChangeCount} onSwitchBranch={onSwitchBranch} onPreviewFile={previewFile} />
          : view === "browser" ? <WorkspaceBrowserPanel projectId={projectId} active={effectiveOpen && inspectorView === "browser"} expanded={focused} onToggleExpanded={() => setBrowserExpanded((value) => !value)} onAttachReference={onAttachBrowserReference ? (value) => { setBrowserExpanded(false); onAttachBrowserReference(value); } : undefined} onWarning={onWarning} onOpenTerminal={() => openInspector("terminal")} onFixPreview={onFixPreview} />
            : view === "references" ? <WorkspaceReferencesPanel projectId={projectId} reference={reference} onSelect={setReference} />
              : <WorkspaceToolsPanel tools={tools} />;
  const changeCount = changes.length;
  // 以真正可用的标签宽度决定折叠；留出滞回空间，避免拖动临界宽度时来回闪动。
  useLayoutEffect(() => {
    const strip = tabStripRef.current;
    const measure = tabMeasureRef.current;
    if (!strip || !measure) return;
    const update = (): void => {
      if (!measure.scrollWidth) return;
      // 按目标宽度决定标签形态，避免开合插值期间文字与图标来回切换。
      setCompactTabs((current) => panelWidth - 80 < measure.scrollWidth + (current ? 24 : 0));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [effectiveOpen, panelWidth, projectId]);

  useLayoutEffect(() => {
    const root = panelRef.current?.closest<HTMLElement>(".biny-app-shell");
    if (!root) return;
    // 只观察窗口容器尺寸；侧栏动画的 ResizeObserver 通知曾让整棵 App 每帧提交。
    // 左栏目标宽度直接参与上面的派生计算，拖拽仍跟随状态实时更新。
    const measure = (): void => { setViewportWidth(root.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [effectiveOpen, projectId]);

  const inspector = visitedViews.size > 0 && projectId ? (
    <div
      ref={panelRef}
      className={`desktop-inspector-wrap is-${effectiveOpen ? "open" : "closed"}${filePanelResizing ? " is-resizing" : ""}`}
      inert={!inspectorOpen}
      aria-hidden={!inspectorOpen}
    >
      <FilePanelResizer
        onResizeEnd={onFilePanelResizeEnd}
        onResizeStart={onFilePanelResizeStart}
        onWidthChange={onFilePanelWidthChange}
        width={panelWidth}
      />
      <aside aria-label="工作区工具" className="desktop-inspector" role="complementary">
        <header className="desktop-inspector-header">
          <nav aria-label="工具切换" className="biny-inspector-tabs" role="tablist" ref={tabStripRef} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const index = inspectorViews.indexOf(inspectorView);
            const next = event.key === "Home" ? 0 : event.key === "End" ? inspectorViews.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + inspectorViews.length) % inspectorViews.length;
            event.preventDefault();
            openInspector(inspectorViews[next]!);
            event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button')[next]?.focus();
          }}>
            <div className="inspector-tab-measure" aria-hidden="true" ref={tabMeasureRef}>{inspectorViews.map((view) => <span key={view}><Icon name={inspectorViewMetadata[view].icon} size={14} />{inspectorViewMetadata[view].label}{view === "changes" && changeCount > 0 ? "99+" : ""}</span>)}</div>
            {(Object.keys(inspectorViewMetadata) as InspectorView[]).map((view) => {
              const active = inspectorView === view;
              const count = view === "commit" ? gitChangeCount ?? 0 : view === "changes" ? changeCount : 0;
              const badge = count > 0 ? (count > 99 ? "99+" : String(count)) : undefined;
              return (
                <button
                  role="tab"
                  aria-selected={active}
                  aria-controls={`inspector-panel-${view}`}
                  id={`inspector-tab-${view}`}
                  tabIndex={active ? 0 : -1}
                  aria-label={inspectorViewMetadata[view].label}
                  className={`biny-inspector-tab${active ? " is-active" : ""}${compactTabs ? " is-compact" : ""}`}
                  key={view}
                  onClick={() => openInspector(view)}
                  title={view === "files" ? undefined : inspectorViewMetadata[view].label}
                  type="button"
                >
                  <Icon name={inspectorViewMetadata[view].icon} size={compactTabs ? 16 : 14} />
                  {!compactTabs ? <span>{inspectorViewMetadata[view].label}</span> : null}
                  {badge !== undefined ? <span className="biny-inspector-badge">{badge}</span> : null}
                </button>
              );
            })}
          </nav>
          <button aria-label="切换会话时保持工具栏展开" aria-pressed={pinned} className="desktop-inspector-close" title="切换会话时保持展开" onClick={() => setPinned((value) => !value)} type="button"><Icon name="pin" size={14} /></button>
          <button aria-label="收起工作区工具" className="desktop-inspector-close" onClick={() => setInspectorOpen(false)} title="收起工作区工具" type="button">
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="desktop-inspector-body" id="desktop-inspector-panel">
          {inspectorViews.filter((view) => visitedViews.has(view)).map((view) => <div className="biny-inspector-view-content" role="tabpanel" aria-labelledby={`inspector-tab-${view}`} id={`inspector-panel-${view}`} data-active={inspectorView === view} aria-hidden={inspectorView !== view} inert={inspectorView !== view} key={(view === "terminal" || view === "browser") ? `${projectId}:${view}` : `${source}:${view}`}>{toolContent(view)}</div>)}
        </div>
      </aside>
    </div>
  ) : undefined;

  // rail 与 dock 使用同一次提交的开合值；保留 DOM 让 CSS 负责可中断的进退场。
  const railVisible = Boolean(projectId) && !effectiveOpen;

  return {
    dock: inspector,
    rail: projectId ? (
      <div
        aria-hidden={!railVisible}
        inert={!railVisible}
        aria-label="工作区工具"
        className={`biny-inspector-rail${railVisible ? " is-visible" : ""}`}
        role="toolbar"
      >
        {inspectorViews.map((view) => (
          <WorkspaceRailButton
            label={inspectorViewMetadata[view].label}
            key={view}
            onClick={() => openRailAction(view)}
            tabIndex={railVisible ? 0 : -1}
            tooltip={view !== "files"}
          >
            <Icon name={inspectorViewMetadata[view].icon} size={16} />
            {view === "changes" && changeCount > 0 ? <span className="biny-inspector-badge is-corner">{changeCount > 99 ? "99+" : changeCount}</span> : null}
          </WorkspaceRailButton>
        ))}
      </div>
    ) : undefined,
    layout: {
      open: inspectorOpen && Boolean(projectId),
      focused,
      resizing: filePanelResizing,
      width: panelWidth
    },
    filesOpen: inspectorOpen && inspectorView === "files",
    terminalOpen: inspectorOpen && inspectorView === "terminal",
    openFiles,
    showBrowser,
    previewFile,
    previewReference,
    toggleTerminal
  };
}

function FilePanelResizer({ width, onWidthChange, onResizeStart, onResizeEnd }: {
  width: number;
  onWidthChange(width: number): void;
  onResizeStart(): void;
  onResizeEnd(width: number): void;
}): React.JSX.Element {
  const resizeWithKeyboard = (direction: -1 | 1, resizer: HTMLDivElement): void => {
    const layoutRoot = resizer.closest<HTMLElement>(".biny-app-shell");
    const currentWidth = resizer.parentElement?.getBoundingClientRect().width ?? width;
    const next = clampFilePanelWidthForLayout(currentWidth + direction * 16, layoutRoot);
    onWidthChange(next);
    onResizeEnd(next);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizeStart();
    const layoutRoot = event.currentTarget.closest<HTMLElement>(".biny-app-shell");
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    let currentWidth = startWidth;
    let active = true;
    const move = (moveEvent: PointerEvent): void => {
      currentWidth = clampFilePanelWidthForLayout(startWidth + startX - moveEvent.clientX, layoutRoot);
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
      aria-label="调整检查器宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_FILE_PANEL_WIDTH}
      aria-valuemin={MIN_FILE_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      className="desktop-inspector-resizer"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); resizeWithKeyboard(1, event.currentTarget); }
        if (event.key === "ArrowRight") { event.preventDefault(); resizeWithKeyboard(-1, event.currentTarget); }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    />
  );
}

function clampFilePanelWidthForLayout(width: number, layoutRoot: HTMLElement | null): number {
  const appWidth = layoutRoot?.clientWidth ?? document.documentElement.clientWidth;
  const sidebar = layoutRoot?.querySelector<HTMLElement>(":scope > .biny-sidebar-block");
  const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0;
  return clampFilePanelWidth(width, appWidth, sidebarWidth);
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}
