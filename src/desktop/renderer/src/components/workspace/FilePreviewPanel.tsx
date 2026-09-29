/**
 * 右侧 Inspector 的文件面板。
 *
 * 左侧文件树可收起、宽度可拖拽，右侧独立阅读文件。文本/代码走高亮 + 行号 gutter；图片走主进程
 * data URL 内联显示；二进制/超限给「使用系统应用打开」兜底。文件树支持懒加载展开
 * 和名称过滤。这里只做展示与本地交互，数据请求全部由 useWorkspaceInspector 的回调注入。
 */
import { memo, useDeferredValue, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import type {
  DesktopWorkspaceDirectoryEntry,
  DesktopWorkspaceFilePreview
} from "../../../../protocol.js";
import { useHighlightedCode } from "../../useHighlightedCode.js";
import { useInlineImageState } from "../../inlineImage.js";
import { CopyButton } from "../CopyButton.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { Icon } from "../Icon.js";
import { FileTypeMarker } from "./FileTypeMarker.js";

export interface FilePreviewState {
  source: string;
  path: string;
  status: "loading" | "ready" | "error";
  file?: DesktopWorkspaceFilePreview;
  error?: string;
  revision?: number;
}

export interface FileDirectoryState {
  status: "loading" | "ready" | "error";
  entries?: DesktopWorkspaceDirectoryEntry[];
  error?: string;
}

/** 文件树宽度约束（120–400、默认 200）；预览区最小保留宽度。 */
const MIN_TREE_WIDTH = 120;
const MAX_TREE_WIDTH = 400;
const DEFAULT_TREE_WIDTH = 200;
const MIN_PREVIEW_WIDTH = 160;

export const FilePreviewPanel = memo(function FilePreviewPanel({ width, preview, directoryStates, expandedDirectories, projectId, onOpenFile, onPreviewFile, onRunHtml, onShowFiles, onToggleDirectory, onRefresh, onCollapse }: {
  width: number;
  preview?: FilePreviewState;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  projectId: string;
  onOpenFile(path: string): void;
  onPreviewFile(path: string): void;
  onRunHtml(path: string): void;
  onShowFiles(): void;
  onToggleDirectory(path: string): void;
  onRefresh(): void;
  onCollapse(): void;
}): React.JSX.Element {
  const file = preview?.file;
  const path = file?.path ?? preview?.path;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filterOpen, setFilterOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const narrow = width < 520;
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [preferredTreeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const treeWidth = Math.min(preferredTreeWidth, Math.max(MIN_TREE_WIDTH, width - MIN_PREVIEW_WIDTH));
  const [resizing, setResizing] = useState(false);
  const browserOnly = !preview && narrow;
  const treeVisible = browserOnly || (fileTreeOpen && !narrow);
  // 按目标宽度布局，开合中的裁切宽度不回写用户的文件树宽度。
  const startTreeResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const startX = event.clientX;
    const startWidth = treeWidth;
    // 上限用拖拽起点的面板宽算一次；拖树期间面板宽不变，每帧重算反而白费。
    const maxWidth = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, width - MIN_PREVIEW_WIDTH));
    const move = (moveEvent: PointerEvent): void => {
      setTreeWidth(Math.min(maxWidth, Math.max(MIN_TREE_WIDTH, startWidth + moveEvent.clientX - startX)));
    };
    const stop = (): void => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <aside aria-label={preview ? "文件预览" : "文件浏览器"} className="file-preview-panel file-browser-panel">
      <div className={`file-browser-body${resizing ? " is-resizing" : ""}${treeVisible ? "" : " is-tree-hidden"}${browserOnly ? " is-browser-only" : ""}`}>
        <div aria-hidden={treeVisible ? undefined : true} className="file-browser-tree" inert={treeVisible ? undefined : true} style={treeVisible && !browserOnly ? { width: treeWidth } : undefined}>
          <div className="inspector-subtoolbar file-explorer-tools">
            <span>文件</span>
            <button type="button" aria-label="筛选文件" aria-pressed={filterOpen} onClick={() => { setFilterOpen(!filterOpen); setQuery(""); }}><Icon name="search" size={14} /></button>
            <button type="button" aria-label={showHidden ? "隐藏点文件" : "显示隐藏文件"} aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}><Icon name={showHidden ? "eye" : "eye-off"} size={14} /></button>
            <button type="button" aria-label="折叠所有目录" onClick={onCollapse}><Icon name="fold" size={14} /></button>
            <button type="button" aria-label="刷新文件" onClick={onRefresh}><Icon name="refresh" size={14} /></button>
          </div>
          {filterOpen ? <div className="inspector-file-filter"><Icon name="search" size={13} /><input autoFocus aria-label="按名称筛选文件" placeholder="筛选文件…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setQuery(""); setFilterOpen(false); } }} /><button type="button" aria-label="清除筛选" onClick={() => setQuery("")}><Icon name="close" size={12} /></button></div> : null}
          <FileTree
            directoryStates={directoryStates}
            expandedDirectories={expandedDirectories}
            onPreviewFile={onPreviewFile}
            onToggleDirectory={onToggleDirectory}
            path="."
            query={deferredQuery}
            selectedPath={path}
            showHidden={showHidden}
          />
        </div>
        {treeVisible && !browserOnly ? <div aria-label="调整文件树宽度" aria-orientation="vertical" className="file-browser-tree-resizer" onPointerDown={startTreeResize} role="separator" tabIndex={0} aria-valuemin={MIN_TREE_WIDTH} aria-valuemax={MAX_TREE_WIDTH} aria-valuenow={treeWidth} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, width - MIN_PREVIEW_WIDTH, treeWidth + (event.key === "ArrowRight" ? 16 : -16)))); } }} /> : null}
        <div className="file-browser-content">
          {preview ? <>
            <header className="file-browser-path">
              <span className="file-browser-current-path">{narrow ? <button type="button" aria-label="返回文件列表" onClick={onShowFiles}><Icon name="arrow-left" size={14} /></button> : fileTreeOpen ? null : <button type="button" aria-label="显示文件树" onClick={() => setFileTreeOpen(true)}><Icon name="folder-panel" size={14} /></button>}<span className="file-browser-path-label">{path}</span></span>
              <div className="file-browser-path-actions">
                {preview.status === "ready" && path ? <IconButton icon={<Icon name="external" size={14} />} label="使用系统应用打开" onClick={() => onOpenFile(path)} size="sm" variant="ghost" /> : null}
                {!narrow && fileTreeOpen ? <IconButton icon={<Icon name="folder-panel" size={14} />} label="隐藏文件树" onClick={() => setFileTreeOpen(false)} size="sm" variant="ghost" /> : null}
                <IconButton icon={<Icon name="close" size={14} />} label="关闭当前文件" onClick={onShowFiles} size="sm" variant="ghost" />
              </div>
            </header>
            <div className="file-browser-preview-scroll"><FilePreviewContent key={path} preview={preview} projectId={projectId} onOpenFile={onOpenFile} onPreviewFile={onPreviewFile} onRunHtml={onRunHtml} /></div>
          </> : <div className="inspector-empty"><Icon name="file" size={28} /><p>选择要预览的文件</p><small>从左侧文件树选择文件。</small></div>}
        </div>
      </div>
    </aside>
  );
});

/** 可内联显示的图片扩展名（与主进程 readInlineImage 的 media type 表一致）。 */
const imageExtensions = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);

const FilePreviewContent = memo(function FilePreviewContent({ preview, projectId, onOpenFile, onPreviewFile, onRunHtml }: {
  preview: FilePreviewState;
  projectId: string;
  onOpenFile(path: string): void;
  onPreviewFile(path: string): void;
  onRunHtml(path: string): void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [openError, setOpenError] = useState<string>();
  const file = preview.file;
  if (preview.status === "loading") return <PreviewState icon="file" text="正在读取文件…" />;
  if (preview.status === "error") return <PreviewState icon="warning" error text={preview.error ?? "读取失败"}>
    <button className="file-preview-open" onClick={() => onPreviewFile(preview.path)} type="button">重试读取</button>
  </PreviewState>;
  if (!file) return <PreviewState icon="file" text="无法读取文件" />;
  const path = file.path;
  const extension = extensionOf(path);
  if (imageExtensions.has(extension)) return <ImagePreview path={path} projectId={projectId} onOpenFile={onOpenFile} />;
  if (file.binary) {
    return <PreviewState icon="file" text="这是二进制文件，请使用系统应用打开。">
      <button className="file-preview-open" onClick={() => onOpenFile(path)} type="button">使用系统应用打开</button>
    </PreviewState>;
  }
  if (!file.content) return <PreviewState icon="file" text="空文件" />;
  const renderable = extension === "md" || extension === "markdown";
  if (!renderable) return <CodeFilePreview file={file} onRunHtml={extension === "html" || extension === "htm" ? onRunHtml : undefined} />;
  return <div className="inspector-document-preview">
    <div className="inspector-subtoolbar" role="group" aria-label="文件显示模式">
      <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}><Icon name="eye" size={13} />预览</button>
      <button type="button" aria-pressed={mode === "code"} onClick={() => setMode("code")}><Icon name="code" size={13} />源码</button>
      <span />
      <CopyButton label="复制文件内容" showTooltip={false} value={file.content} />
    </div>
    {openError ? <div className="inspector-error" role="alert">{openError}</div> : null}
    {file.truncated && mode === "code" ? <div className="inspector-progress">文件过大，仅显示已读取的部分。</div> : null}
    {mode === "code" ? <CodeFilePreview file={file} /> : <div className="inspector-result-scroll"><MarkdownContent content={file.content} projectId={projectId} onPreviewFile={(target) => onPreviewFile(target.startsWith("/") ? target : `${path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""}${target}`)} onOpenExternal={(url) => { void window.biny.openExternal(url).catch((error: unknown) => setOpenError(String(error))); }} /></div>}
  </div>;
});

/** 文本/代码预览：语言 + 大小元信息行，正文是行号 gutter + 高亮代码。 */
function CodeFilePreview({ file, onRunHtml }: { file: DesktopWorkspaceFilePreview; onRunHtml?(path: string): void }): React.JSX.Element {
  const highlighted = useHighlightedCode(file.content ?? "", undefined, file.path);
  const lines = (file.content ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <div className="file-preview-document">
      <div className="file-preview-meta">
        <span>{highlighted.language ?? "纯文本"}</span>
        <div className="file-preview-meta-actions">
          {onRunHtml ? <button className="file-preview-run" type="button" aria-label="运行页面" onClick={() => onRunHtml(file.path)}><Icon name="globe" size={14} />运行页面</button> : null}
          <span>{formatBytes(file.bytes)}{file.truncated ? " · 仅显示前 512 KB" : ""}</span>
          <CopyButton className="copy-button" label="复制文件内容" showTooltip={false} value={file.content ?? ""} />
        </div>
      </div>
      <div className="file-preview-body">
        <div aria-hidden="true" className="file-preview-gutter">
          {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
        </div>
        <pre className="file-preview-code"><code className={highlighted.language ? `shiki language-${highlighted.language}` : "shiki"} dangerouslySetInnerHTML={{ __html: highlighted.html }} /></pre>
      </div>
    </div>
  );
}

/** 图片预览：主进程转 data URL 内联显示；读不到或超限时退回二进制兜底。 */
function ImagePreview({ path, projectId, onOpenFile }: { path: string; projectId: string; onOpenFile(path: string): void }): React.JSX.Element {
  const { source, loading } = useInlineImageState(projectId, path);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  if (loading) return <PreviewState icon="file" text="正在读取图片…" />;
  if (!source) {
    return (
      <PreviewState icon="file" text="图片无法内联预览，请使用系统应用打开。">
        <button className="file-preview-open" onClick={() => onOpenFile(path)} type="button">使用系统应用打开</button>
      </PreviewState>
    );
  }
  return (
    <div className="file-preview-document">
      <div className="file-preview-meta">
        <span>{extensionOf(path).toUpperCase()}</span>
        <div className="file-preview-meta-actions">
          {dimensions ? <span>{`${String(dimensions.width)} × ${String(dimensions.height)}`}</span> : null}
          <button aria-label="缩小图片" disabled={zoom <= 0.25} onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))} type="button"><Icon name="minus" size={14} /></button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button aria-label="放大图片" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value * 1.25))} type="button"><Icon name="add" size={14} /></button>
          <button aria-label="向左旋转图片" onClick={() => setRotation((value) => value - 90)} type="button">↶</button>
          <button aria-label="向右旋转图片" onClick={() => setRotation((value) => value + 90)} type="button">↷</button>
          <button aria-label="适应窗口" onClick={() => { setZoom(1); setRotation(0); }} type="button"><Icon name="expand" size={14} /></button>
        </div>
      </div>
      <div className="file-preview-image">
        <img
          alt={path}
          onLoad={(event) => {
            const target = event.currentTarget;
            setDimensions({ width: target.naturalWidth, height: target.naturalHeight });
          }}
          src={source}
          style={zoom === 1 && rotation === 0 ? undefined : { transform: `rotate(${rotation}deg) scale(${zoom})` }}
        />
      </div>
    </div>
  );
}

function PreviewState({ icon, text, error, children }: { icon: "file" | "warning"; text: string; error?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`file-preview-state${error ? " is-error" : ""}`}>
      <Icon name={icon} size={18} />
      <span>{text}</span>
      {children}
    </div>
  );
}

const FileTree = memo(function FileTree({ path, query, directoryStates, expandedDirectories, onToggleDirectory, onPreviewFile, selectedPath, showHidden, depth = 0 }: {
  path: string;
  query: string;
  directoryStates: ReadonlyMap<string, FileDirectoryState>;
  expandedDirectories: ReadonlySet<string>;
  onToggleDirectory(path: string): void;
  onPreviewFile(path: string): void;
  depth?: number;
  selectedPath?: string;
  showHidden: boolean;
}): React.JSX.Element {
  const state = directoryStates.get(path);
  if (!state || state.status === "loading") return <div className="file-tree-state"><span className="mini-spinner" /><span>正在读取目录…</span></div>;
  if (state.status === "error") return <div className="file-tree-state is-error"><Icon name="warning" size={14} /><span>{state.error}</span></div>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = (state.entries ?? []).filter((entry) => (showHidden || !entry.name.startsWith(".")) && (!normalizedQuery || entry.kind === "directory" || entry.path.toLocaleLowerCase().includes(normalizedQuery)));
  if (!entries.length) return <div className="file-tree-state">{normalizedQuery ? "没有匹配文件" : "目录为空"}</div>;
  return (
    <div className="file-tree-level" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "工作区文件" : undefined}>
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expandedDirectories.has(entry.path);
        return (
          <div key={entry.path}>
            <button role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined} aria-selected={selectedPath === entry.path} className={`file-tree-row${isDirectory ? " is-directory" : ""}${selectedPath === entry.path ? " is-selected" : ""}`} onClick={() => isDirectory ? onToggleDirectory(entry.path) : onPreviewFile(entry.path)} onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const rows = Array.from(event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []);
                const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
                event.preventDefault(); next?.focus();
              } else if (isDirectory && ((event.key === "ArrowRight" && !isExpanded) || (event.key === "ArrowLeft" && isExpanded))) { event.preventDefault(); onToggleDirectory(entry.path); }
            }} style={{ paddingLeft: `${8 + depth * 16}px` }} type="button">
              {isDirectory ? <span className={`file-tree-disclosure${isExpanded ? " is-expanded" : ""}`}><Icon name="chevron" size={13} /></span> : <span aria-hidden="true" className="file-tree-disclosure is-file-slot" />}
              {isDirectory ? <Icon className="file-tree-folder-icon" name="folder" size={14} /> : <FileTypeMarker name={entry.name} />}
              <span>{entry.name}</span>
            </button>
            {isDirectory && isExpanded ? <FileTree directoryStates={directoryStates} depth={depth + 1} expandedDirectories={expandedDirectories} onPreviewFile={onPreviewFile} onToggleDirectory={onToggleDirectory} path={entry.path} query={query} selectedPath={selectedPath} showHidden={showHidden} /> : null}
          </div>
        );
      })}
    </div>
  );
});

function extensionOf(path: string): string {
  return path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes >= 10_240 ? 0 : 1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}
