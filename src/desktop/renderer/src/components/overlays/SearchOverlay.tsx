/** Cmd+K 项目与任务搜索。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, CommandPaletteInput, useCommandPaletteContext } from "@astryxdesign/core/CommandPalette";
import { createStaticSource, type SearchableItem, type SearchSource } from "@astryxdesign/core/Typeahead";
import type { DesktopProject, DesktopSessionSummary } from "../../../../protocol.js";
import { matchDesktopWorkspaceFiles, type DesktopWorkspaceFileIndex } from "../../../../projectFiles.js";
import { loadRecentSearches, rememberRecentSearch, removeRecentSearch, type RecentSearchStorage } from "../../../../recentSearches.js";
import { Icon } from "../Icon.js";

interface SearchOverlayProps {
  open: boolean;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  selectedProjectId?: string;
  onClose(): void;
  onProject(projectId: string): void;
  onSession(projectId: string, sessionId: string): void;
  onFile(path: string): void;
}

type DesktopSearchItem = SearchableItem<{
  detail: string;
  group: string;
  keywords: string[];
  kind: "project" | "session" | "file" | "recent";
  projectId: string;
  targetId: string;
}>;

function getRecentSearchStorage(): RecentSearchStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function SearchPaletteInput({ itemById }: { itemById: { current: Map<string, DesktopSearchItem> } }): React.JSX.Element {
  const palette = useCommandPaletteContext();
  return (
    <CommandPaletteInput
      endContent={<kbd>⌘K</kbd>}
      label="搜索项目、任务或当前项目文件"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !palette) return;
        const selected = palette.selectableItems[palette.highlightedIndex];
        const item = selected ? itemById.current.get(selected.value) : undefined;
        if (item?.auxiliaryData?.kind !== "recent") return;
        event.preventDefault();
        event.stopPropagation();
        palette.setSearch(item.auxiliaryData.targetId);
      }}
      placeholder="搜索项目、任务或当前项目文件…"
    />
  );
}

function SearchResultRow({
  item,
  onRemoveRecent
}: {
  item: DesktopSearchItem;
  onRemoveRecent(query: string): void;
}): React.JSX.Element {
  const palette = useCommandPaletteContext();
  const data = item.auxiliaryData;
  const isRecent = data?.kind === "recent";
  return (
    <div
      className="command-palette-row"
      onClick={isRecent ? (event) => {
        event.stopPropagation();
        palette?.setSearch(data.targetId);
      } : undefined}
    >
      <Icon name={isRecent ? "search" : data?.kind === "project" ? "folder" : data?.kind === "file" ? "file-text" : "edit"} size={14} />
      <span className="command-palette-row-copy">
        <strong>{item.label}</strong>
        {data?.detail && <small>{data.detail}</small>}
      </span>
      {isRecent ? (
        <button
          aria-label={`移除最近搜索：${item.label}`}
          className="command-palette-row-remove"
          onClick={(event) => {
            event.stopPropagation();
            onRemoveRecent(data.targetId);
            palette?.setSearch("");
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title="移除最近搜索"
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      ) : (
        <span className="command-palette-row-path">{data?.kind === "file" ? "在侧边打开" : "打开"}</span>
      )}
    </div>
  );
}

export function SearchOverlay({
  open,
  projects,
  sessions,
  selectedProjectId,
  onClose,
  onProject,
  onSession,
  onFile
}: SearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [recentQueries, setRecentQueries] = useState<string[]>(() => loadRecentSearches(getRecentSearchStorage()));
  const [fileIndex, setFileIndex] = useState<DesktopWorkspaceFileIndex>();
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const queryRef = useRef("");
  const recentQueriesRef = useRef(recentQueries);
  const fileIndexRequest = useRef(0);
  const fileIndexPromise = useRef<{ projectId: string; promise: Promise<DesktopWorkspaceFileIndex> } | undefined>(undefined);
  const itemById = useRef(new Map<string, DesktopSearchItem>());

  useEffect(() => {
    if (!open) {
      setQuery("");
      queryRef.current = "";
      setFileIndex(undefined);
      setFileIndexLoading(false);
      fileIndexPromise.current = undefined;
      return;
    }

    const storedQueries = loadRecentSearches(getRecentSearchStorage());
    recentQueriesRef.current = storedQueries;
    setRecentQueries(storedQueries);
    if (!selectedProjectId) {
      setFileIndex(undefined);
      setFileIndexLoading(false);
      fileIndexPromise.current = undefined;
      return;
    }

    const request = ++fileIndexRequest.current;
    let cancelled = false;
    setFileIndex(undefined);
    setFileIndexLoading(true);
    const promise = window.biny.workspaceFileIndex(selectedProjectId);
    fileIndexPromise.current = { projectId: selectedProjectId, promise };
    void promise.then(index => {
      if (!cancelled && fileIndexRequest.current === request) setFileIndex(index);
    }).catch(() => {
      if (!cancelled && fileIndexRequest.current === request) setFileIndex(undefined);
    }).finally(() => {
      if (!cancelled && fileIndexRequest.current === request) setFileIndexLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, selectedProjectId]);

  const projectById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const staticItems = useMemo<DesktopSearchItem[]>(() => [
    ...projects.map(project => ({
      id: `project:${project.id}`,
      label: project.name,
      auxiliaryData: {
        detail: project.path,
        group: "项目",
        keywords: [project.path],
        kind: "project" as const,
        projectId: project.id,
        targetId: project.id
      }
    })),
    ...sessions.map(session => {
      const project = projectById.get(session.projectId);
      return {
        id: `session:${session.projectId}:${session.id}`,
        label: session.title,
        auxiliaryData: {
          detail: `${project?.name ?? "未知项目"} · ${session.firstUserMessage || "空会话"}`,
          group: "任务",
          keywords: [project?.name ?? "", project?.path ?? "", session.firstUserMessage],
          kind: "session" as const,
          projectId: session.projectId,
          targetId: session.id
        }
      };
    })
  ], [projects, projectById, sessions]);
  const searchSource = useMemo<SearchSource<DesktopSearchItem>>(() => {
    const staticSource = createStaticSource(staticItems, {
      keywords: item => item.auxiliaryData?.keywords ?? []
    });
    const remember = (items: DesktopSearchItem[]): DesktopSearchItem[] => {
      for (const item of items) itemById.current.set(item.id, item);
      return items;
    };
    return {
      async search(value) {
        setQuery(value);
        queryRef.current = value;
        const results = await staticSource.search(value);
        const trimmed = value.trim();
        if (trimmed.length < 2 || !selectedProjectId) return remember(results);
        let index = fileIndex;
        if (!index) {
          const pending = fileIndexPromise.current;
          if (pending?.projectId === selectedProjectId) {
            try { index = await pending.promise; } catch { index = undefined; }
          }
        }
        if (!index) return remember(results);
        const project = projectById.get(selectedProjectId);
        const files: DesktopSearchItem[] = matchDesktopWorkspaceFiles(index.files, trimmed).map(file => ({
          id: `file:${selectedProjectId}:${file.path}`,
          label: file.name,
          auxiliaryData: {
            detail: file.path,
            group: `${project?.name ?? "当前项目"} · 文件${index.incomplete ? "（扫描不完整）" : ""}`,
            keywords: [file.path],
            kind: "file",
            projectId: selectedProjectId,
            targetId: file.path
          }
        }));
        return remember([...results, ...files]);
      },
      async bootstrap() {
        setQuery("");
        queryRef.current = "";
        const recent: DesktopSearchItem[] = recentQueriesRef.current.map(recentQuery => ({
          id: `recent:${recentQuery}`,
          label: recentQuery,
          auxiliaryData: {
            detail: "最近搜索",
            group: "最近搜索",
            keywords: [],
            kind: "recent",
            projectId: "",
            targetId: recentQuery
          }
        }));
        return remember([...recent, ...await staticSource.bootstrap()]);
      }
    };
  }, [fileIndex, projectById, selectedProjectId, staticItems]);

  const removeRecent = (recentQuery: string): void => {
    const nextQueries = removeRecentSearch(getRecentSearchStorage(), recentQuery);
    recentQueriesRef.current = nextQueries;
    setRecentQueries(nextQueries);
  };

  return (
    <CommandPalette
      emptyBootstrapText="还没有可搜索的项目或任务"
      emptySearchText={fileIndexLoading && query.trim().length >= 2 ? "正在搜索当前项目文件…" : "没有匹配结果"}
      input={<SearchPaletteInput itemById={itemById} />}
      isOpen={open}
      label="快速打开"
      maxHeight="min(560px, calc(100vh - 96px))"
      onOpenChange={isOpen => { if (!isOpen) onClose(); }}
      onValueChange={value => {
        const selected = itemById.current.get(value)?.auxiliaryData;
        if (!selected || selected.kind === "recent") return;
        const nextQueries = rememberRecentSearch(getRecentSearchStorage(), queryRef.current);
        recentQueriesRef.current = nextQueries;
        setRecentQueries(nextQueries);
        if (selected.kind === "project") onProject(selected.targetId);
        else if (selected.kind === "session") onSession(selected.projectId, selected.targetId);
        else onFile(selected.targetId);
        onClose();
      }}
      renderItem={item => <SearchResultRow item={item} onRemoveRecent={removeRecent} />}
      searchSource={searchSource}
      width="min(680px, calc(100vw - 48px))"
    />
  );
}
