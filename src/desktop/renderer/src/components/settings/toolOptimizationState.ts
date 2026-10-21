import type { DesktopApi, DesktopToolOptimizationStats } from "../../../../protocol.js";

interface StatisticsSnapshot {
  data?: DesktopToolOptimizationStats;
  error?: string;
}

function createToolOptimizationState(api: DesktopApi) {
  let snapshot: StatisticsSnapshot = {};
  let pending: Promise<void> | undefined;
  let lastRead = 0;
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh(force = false): Promise<void> {
      if (pending) return pending;
      if (!force && snapshot.data && Date.now() - lastRead < 10_000) return Promise.resolve();
      snapshot = { data: snapshot.data };
      pending = Promise.resolve().then(() => api.toolOptimizationStats("all")).then(data => {
        snapshot = { data };
        lastRead = Date.now();
      }, error => { snapshot = { data: snapshot.data, error: String(error) }; }).finally(() => {
        pending = undefined;
        publish();
      });
      publish();
      return pending;
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
