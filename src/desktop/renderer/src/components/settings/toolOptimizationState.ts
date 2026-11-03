import type { DesktopApi, DesktopToolOptimizationStats } from "../../../../protocol.js";

interface StatisticsSnapshot {
  data?: DesktopToolOptimizationStats;
  error?: string;
}

function createToolOptimizationState(api: DesktopApi) {
  let snapshot: StatisticsSnapshot = {};
  let pending: Promise<void> | undefined;
  let lastRead = 0;
  let revision = 0;
  let readRevision = -1;
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of listeners) listener(); };
  function refresh(force = false): Promise<void> {
    if (pending) return pending;
    // 回合终态会主动失效；低频校验只补获其他进程写入、导入或删除的历史变化。
    if (!force && !snapshot.error && snapshot.data && readRevision === revision && Date.now() - lastRead < 300_000) return Promise.resolve();
    const startedRevision = revision;
    let succeeded = false;
    const refreshHistory = force || Boolean(snapshot.data);
    snapshot = { data: snapshot.data };
    pending = Promise.resolve().then(() => refreshHistory
      ? api.toolOptimizationStats("all", undefined, undefined, true)
      : api.toolOptimizationStats("all")).then(async data => {
      snapshot = { data };
      if (data.stale) {
        publish();
        data = await api.toolOptimizationStats("all", undefined, undefined, true);
      }
      snapshot = { data };
      lastRead = Date.now();
      readRevision = startedRevision;
      succeeded = true;
    }).catch(error => { snapshot = { data: snapshot.data, error: String(error) }; }).finally(() => {
      pending = undefined;
      publish();
      if (succeeded && revision !== startedRevision && listeners.size) void refresh();
    });
    publish();
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    invalidate(): void {
      revision++;
      if (listeners.size) void refresh();
    }
  };
}

// 累计统计属于当前 Desktop 窗口，不随设置分页卸载；桥释放后不保留另一窗口的数据。
const states = new WeakMap<DesktopApi, ReturnType<typeof createToolOptimizationState>>();
export function toolOptimizationState(api: DesktopApi) {
  let state = states.get(api);
  if (!state) { state = createToolOptimizationState(api); states.set(api, state); }
  return state;
}

export function invalidateToolOptimizationStats(api: DesktopApi): void {
  states.get(api)?.invalidate();
}
