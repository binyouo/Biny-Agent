import type { DesktopSessionSummary, DesktopSessionTreePage, DesktopWorkspaceSnapshot } from "../../../protocol.js";

/** Renderer-only reset receipt; IPC revisionChanged still means an invalid/empty page. */
export interface LoadedSessionTreePage extends DesktopSessionTreePage {
  /** A successful first-page restart discarded these previously loaded descendants. */
  resetSessionIds?: string[];
}

interface CatalogRefresh {
  read(): Promise<DesktopWorkspaceSnapshot>;
  publish(snapshot: DesktopWorkspaceSnapshot): void;
  onError(error: unknown): void;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface CatalogProject {
  publication: object;
  refresh?: CatalogRefresh;
}

// Match the existing event-refresh debounce; never spin on a superseded read.
const CATALOG_REFRESH_DELAY_MS = 260;

/** Independent tree-page ownership and archive-triggered catalog reconciliation.
 * Catalog hashes are equality/CAS tokens, never ordered versions. */
export function createSessionTreePageLifetime() {
  let lifetime = {};
  const projects = new Map<string, object>();
  const pages = new Map<string, Map<string, object>>();
  const parents = new Map<string, Map<string, string | undefined>>();
  const catalogProjects = new Map<string, CatalogProject>();
  const cancelCatalogRefresh = (project: CatalogProject): void => {
    if (project.refresh?.timer !== undefined) clearTimeout(project.refresh.timer);
    project.refresh = undefined;
  };
  const scheduleCatalogRefresh = (projectId: string, project: CatalogProject, refresh: CatalogRefresh): void => {
    if (refresh.running) return;
    if (refresh.timer !== undefined) clearTimeout(refresh.timer);
    refresh.timer = setTimeout(() => {
      refresh.timer = undefined;
      const ownsRequest = (): boolean => catalogProjects.get(projectId) === project && project.refresh === refresh;
      if (!ownsRequest()) return;
      refresh.running = true;
      const publication = project.publication;
      void (async () => {
        let snapshot: DesktopWorkspaceSnapshot;
        try {
          snapshot = await refresh.read();
        } catch (error) {
          if (!ownsRequest()) return;
          refresh.running = false;
          if (project.publication !== publication) {
            scheduleCatalogRefresh(projectId, project, refresh);
          } else {
            project.refresh = undefined;
            refresh.onError(error);
          }
          return;
        }
        if (!ownsRequest()) return;
        refresh.running = false;
        if (project.publication !== publication) {
          scheduleCatalogRefresh(projectId, project, refresh);
          return;
        }
        // Adoption itself calls observe/replaceProject. Retire this demand first
        // so its own publication cannot enqueue another read indefinitely.
        project.refresh = undefined;
        try { refresh.publish(snapshot); }
        catch (error) { refresh.onError(error); }
      })();
    }, CATALOG_REFRESH_DELAY_MS);
  };
  const acceptCatalog = (projectId: string): void => {
    const project = catalogProjects.get(projectId) ?? { publication: {} };
    catalogProjects.set(projectId, project);
    project.publication = {};
    if (project.refresh) scheduleCatalogRefresh(projectId, project, project.refresh);
  };
  const observe = (projectId: string, sessions: readonly DesktopSessionSummary[]): void => {
    const links = parents.get(projectId) ?? new Map<string, string | undefined>();
    for (const session of sessions) {
      if (session.projectId === projectId) links.set(session.id, session.parentSessionId);
    }
    parents.set(projectId, links);
    acceptCatalog(projectId);
  };
  return {
    observe,
    /** Removal/recreation revokes this owner; ordinary catalog replacement does not. */
    captureCatalogProject(projectId: string): () => boolean {
      const project = catalogProjects.get(projectId);
      return () => project !== undefined && catalogProjects.get(projectId) === project;
    },
    /** Successful archive writes demand a fresh catalog; the mutation response is not adopted. */
    refreshCatalog(
      projectId: string,
      read: CatalogRefresh["read"],
      publish: CatalogRefresh["publish"],
      onError: CatalogRefresh["onError"]
    ): void {
      const project = catalogProjects.get(projectId);
      if (!project) return;
      // A later successful write invalidates a read even before another catalog
      // response has been accepted. Keep one flight and one coalesced demand.
      project.publication = {};
      const refresh = project.refresh ?? { read, publish, onError, running: false };
      project.refresh = refresh;
      scheduleCatalogRefresh(projectId, project, refresh);
    },
    capture(projectId: string, parentSessionId: string): () => boolean {
      const capturedLifetime = lifetime;
      const project = projects.get(projectId);
      const page = pages.get(projectId)?.get(parentSessionId);
      return () => capturedLifetime === lifetime && project === projects.get(projectId)
        && page === pages.get(projectId)?.get(parentSessionId);
    },
    replaceProject(projectId: string, sessions: readonly DesktopSessionSummary[]): void {
      projects.set(projectId, {});
      pages.delete(projectId);
      parents.delete(projectId);
      observe(projectId, sessions);
    },
    replaceAll(sessions: readonly DesktopSessionSummary[] = [], projectIds?: readonly string[]): void {
      const retained = new Set(projectIds ?? sessions.map(session => session.projectId));
      for (const [projectId, project] of catalogProjects) {
        if (retained.has(projectId)) continue;
        cancelCatalogRefresh(project);
        catalogProjects.delete(projectId);
      }
      for (const projectId of retained) acceptCatalog(projectId);
      lifetime = {};
      projects.clear();
      pages.clear();
      parents.clear();
      for (const session of sessions) observe(session.projectId, [session]);
    },
    restart(
      projectId: string,
      parentSessionId: string,
      firstPage: readonly DesktopSessionSummary[],
      pinnedSessions: readonly DesktopSessionSummary[] = []
    ): string[] {
      const links = parents.get(projectId) ?? new Map<string, string | undefined>();
      const children = new Map<string, string[]>();
      for (const [id, parent] of links) {
        if (parent === undefined) continue;
        const siblings = children.get(parent) ?? [];
        siblings.push(id);
        children.set(parent, siblings);
      }
      const descendants = new Set<string>();
      const queue = [parentSessionId];
      for (let index = 0; index < queue.length; index += 1) {
        for (const id of children.get(queue[index]!) ?? []) {
          if (id === parentSessionId || descendants.has(id)) continue;
          descendants.add(id);
          queue.push(id);
        }
      }
      // Fresh first-page IDs also lose old local expansion state if an ID was recreated.
      for (const session of firstPage) descendants.add(session.id);
      const pageLifetimes = pages.get(projectId) ?? new Map<string, object>();
      for (const id of [parentSessionId, ...descendants]) pageLifetimes.set(id, {});
      pages.set(projectId, pageLifetimes);
      // 置顶孙节点可能保留，但中间父节点不在新页；只保留其清理所需的祖先关系，
      // 不保留旧摘要，确保下次重置仍能移除已取消置顶或删除的后代。
      const pinnedAncestors = new Set<string>();
      for (const session of pinnedSessions) {
        let id: string | undefined = session.id;
        while (id !== undefined && descendants.has(id) && !pinnedAncestors.has(id)) {
          pinnedAncestors.add(id);
          id = links.get(id);
        }
      }
      for (const id of descendants) if (!pinnedAncestors.has(id)) links.delete(id);
      parents.set(projectId, links);
      observe(projectId, firstPage);
      return [...descendants];
    }
  };
}
