import type { DesktopSessionSummary, DesktopSessionTreePage } from "../../../protocol.js";

/** Renderer-only reset receipt; IPC revisionChanged still means an invalid/empty page. */
export interface LoadedSessionTreePage extends DesktopSessionTreePage {
  /** A successful first-page restart discarded these previously loaded descendants. */
  resetSessionIds?: string[];
}

/** Tree-page ownership only: no ordering of catalog hashes or runtime fields. */
export function createSessionTreePageLifetime() {
  let lifetime = {};
  const projects = new Map<string, object>();
  const pages = new Map<string, Map<string, object>>();
  const parents = new Map<string, Map<string, string | undefined>>();
  const observe = (projectId: string, sessions: readonly DesktopSessionSummary[]): void => {
    const links = parents.get(projectId) ?? new Map<string, string | undefined>();
    for (const session of sessions) {
      if (session.projectId === projectId) links.set(session.id, session.parentSessionId);
    }
    parents.set(projectId, links);
  };
  return {
    observe,
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
    replaceAll(sessions: readonly DesktopSessionSummary[] = []): void {
      lifetime = {};
      projects.clear();
      pages.clear();
      parents.clear();
      for (const session of sessions) observe(session.projectId, [session]);
    },
    restart(projectId: string, parentSessionId: string, firstPage: readonly DesktopSessionSummary[]): string[] {
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
      for (const id of descendants) links.delete(id);
      parents.set(projectId, links);
      observe(projectId, firstPage);
      return [...descendants];
    }
  };
}
