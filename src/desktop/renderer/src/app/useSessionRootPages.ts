import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopSessionSummary, DesktopSessionTreePage, DesktopWorkspaceSnapshot } from "../../../protocol.js";
import { mergeProjectSessionPage, replaceProjectSessions } from "./desktopState.js";
import type { createSessionTreePageLifetime, LoadedSessionTreePage } from "./sessionTreePageLifetime.js";

export interface SessionRootPageState {
  initialized: boolean;
  nextCursor?: string;
  revision?: string;
  loading: boolean;
  error?: string;
}

type RootRequest = { promise?: Promise<LoadedSessionTreePage | undefined> };

/** Continuation belongs to the listed project, never the selected conversation. */
export function useSessionRootPages(
  tree: ReturnType<typeof createSessionTreePageLifetime>,
  sessions: DesktopSessionSummary[],
  setSessions: Dispatch<SetStateAction<DesktopSessionSummary[]>>
) {
  const visible = useRef(sessions);
  useLayoutEffect(() => { visible.current = sessions; }, [sessions]);
  const requests = useRef(new Map<string, RootRequest>());
  const delivered = useRef(new Map<string, Set<string>>());
  const loadedIds = useCallback((projectId: string): ReadonlySet<string> => delivered.current.get(projectId) ?? new Set(), []);
  const pages = useRef(new Map<string, SessionRootPageState>());
  const [states, setStates] = useState<ReadonlyMap<string, SessionRootPageState>>(() => new Map());
  const publish = useCallback((projectId: string, state: SessionRootPageState): void => {
    pages.current.set(projectId, state);
    setStates(new Map(pages.current));
  }, []);
  const adopt = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    requests.current.delete(snapshot.project.id);
    const existing = pages.current.get(snapshot.project.id);
    const liveIds = new Set(snapshot.sessions.map(session => session.id));
    delivered.current.set(snapshot.project.id, new Set([
      ...[...loadedIds(snapshot.project.id)].filter(id => liveIds.has(id)),
      ...(snapshot.sessionPage?.sessions.map(session => session.id) ?? [])
    ]));
    const sameRevision = snapshot.sessionPage !== undefined && existing?.revision === snapshot.sessionPage.revision;
    publish(snapshot.project.id, {
      initialized: true,
      nextCursor: sameRevision ? existing.nextCursor : snapshot.sessionPage?.nextCursor,
      revision: snapshot.sessionPage?.revision,
      loading: false
    });
  }, [loadedIds, publish]);
  const reset = useCallback((snapshot?: DesktopWorkspaceSnapshot): void => {
    requests.current.clear();
    pages.current.clear();
    delivered.current.clear();
    setStates(new Map());
    if (snapshot) adopt(snapshot);
  }, [adopt]);
  const invalidate = useCallback((projectId: string): void => {
    requests.current.delete(projectId);
    publish(projectId, { initialized: false, loading: false });
  }, [publish]);
  const load = useCallback((projectId: string): Promise<LoadedSessionTreePage | undefined> => {
    const pending = requests.current.get(projectId)?.promise;
    if (pending) return pending;
    const initial = pages.current.get(projectId);
    if (initial?.initialized && !initial.nextCursor) return Promise.resolve(undefined);
    const request: RootRequest = {};
    const ownsTree = tree.capture(projectId);
    const current = (): boolean => requests.current.get(projectId) === request && ownsTree();
    requests.current.set(projectId, request);
    publish(projectId, { initialized: initial?.initialized ?? false, nextCursor: initial?.nextCursor, revision: initial?.revision, loading: true });
    request.promise = (async () => {
      let cursor = initial?.nextCursor;
      const visitedCursors = new Set<string>();
      try {
        // An inactive project's bootstrap carries rows but no cursor. A refreshed
        // snapshot may also retain already-loaded rows beyond its first page.
        // Skip duplicate pages so one click still advances, without using offsets.
        while (true) {
          if (cursor !== undefined) {
            if (visitedCursors.has(cursor)) throw new Error("会话分页游标重复，请刷新项目后重试。");
            visitedCursors.add(cursor);
          }
          let page: DesktopSessionTreePage = await window.biny.listSessionTreePage(projectId, { limit: 32, includeArchived: true, cursor });
          if (!current()) return undefined;
          const restarted = page.revisionChanged === true;
          if (restarted) {
            page = await window.biny.listSessionTreePage(projectId, { limit: 32, includeArchived: true, includePinnedSessions: true });
            if (!current()) return undefined;
            if (page.revisionChanged) throw new Error("会话列表已更新，请重新加载重试。");
          }
          const visibleIds = new Set(visible.current.filter(session => session.projectId === projectId).map(session => session.id));
          if (restarted) {
            const next = [...page.sessions, ...(page.pinnedSessions ?? [])];
            delivered.current.set(projectId, new Set(page.sessions.map(session => session.id)));
            tree.replaceProject(projectId, next);
            setSessions(previous => replaceProjectSessions(previous, projectId, [...new Map(next.map(session => [session.id, session])).values()]));
            publish(projectId, { initialized: true, nextCursor: page.nextCursor, revision: page.revision, loading: false });
            return { ...page, resetSessionIds: [...visibleIds] };
          }
          if (page.nextCursor && visitedCursors.has(page.nextCursor)) throw new Error("会话分页游标未前进，请刷新项目后重试。");
          delivered.current.set(projectId, new Set([...loadedIds(projectId), ...page.sessions.map(session => session.id)]));
          tree.observe(projectId, page.sessions);
          setSessions(previous => mergeProjectSessionPage(previous, projectId, page.sessions));
          if (page.sessions.some(session => !visibleIds.has(session.id)) || !page.nextCursor) {
            publish(projectId, { initialized: true, nextCursor: page.nextCursor, revision: page.revision, loading: false });
            return page;
          }
          cursor = page.nextCursor;
        }
      } catch {
        if (current()) publish(projectId, { initialized: initial?.initialized ?? false, nextCursor: initial?.nextCursor, revision: initial?.revision, loading: false, error: "加载失败，请重试。" });
        return undefined;
      } finally {
        if (requests.current.get(projectId) === request) requests.current.delete(projectId);
      }
    })();
    return request.promise;
  }, [loadedIds, publish, setSessions, tree]);
  return { states, adopt, reset, invalidate, load, loadedIds };
}
