import type { DesktopApi, DesktopMaskingOverview } from "../../../../protocol.js";

interface Snapshot { data?: DesktopMaskingOverview; error?: string; loading: boolean }
function createState(api: DesktopApi, projectId: string) {
  let snapshot: Snapshot = { loading: false }, pending: Promise<void> | undefined;
  let lastRead = 0, revision = 0, refreshAfter = false, clearing = false;
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of listeners) listener(); };
  const state = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh(force = false): Promise<void> {
      if (clearing) return pending ?? Promise.resolve();
      if (pending) { refreshAfter ||= force; return pending; }
      if (!force && snapshot.data && Date.now() - lastRead < 10_000) return Promise.resolve();
      const version = revision;
      snapshot = { data: snapshot.data, loading: true };
      pending = Promise.resolve().then(() => api.maskingOverview(projectId)).then(data => {
        if (version === revision) { snapshot = { data, loading: false }; lastRead = Date.now(); }
      }, () => { if (version === revision) snapshot = { data: snapshot.data, loading: false, error: "脱敏记录读取失败，请重试。" }; }).finally(() => {
        pending = undefined; publish();
        if (refreshAfter && !clearing) { refreshAfter = false; void state.refresh(true); }
      });
      publish();
      return pending;
    },
    async clear(): Promise<void> {
      revision++; clearing = true; refreshAfter = false;
      try {
        await pending;
        await api.maskingClear(projectId);
        snapshot = { loading: false }; lastRead = 0;
      } finally { clearing = false; snapshot = { ...snapshot, loading: false }; publish(); }
      await state.refresh(true);
    }
  };
  return state;
}
const states = new WeakMap<DesktopApi, Map<string, ReturnType<typeof createState>>>();
export function privacyState(api: DesktopApi, projectId: string) {
  let projects = states.get(api);
  if (!projects) { projects = new Map(); states.set(api, projects); }
  let state = projects.get(projectId);
  if (!state) {
    state = createState(api, projectId); projects.set(projectId, state);
    if (projects.size > 10) projects.delete(projects.keys().next().value!);
  }
  return state;
}
