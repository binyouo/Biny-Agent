/** 设置窗口内共享 Activity 运行态，避免切换设置页时重复读取并清空已展示状态。 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActivityRuntimeSnapshot } from "../../../../../activity/types.js";
import type { ActivityPermissionStatus } from "../../../../../activity/httpServer.js";

interface ActivityRuntimeContextValue {
  runtime: ActivityRuntimeSnapshot | undefined;
  permissions: ActivityPermissionStatus | undefined;
  permissionError: string | undefined;
  refresh(): Promise<ActivityRuntimeSnapshot>;
  refreshPermissions(): Promise<ActivityPermissionStatus>;
  updateRuntime(next: ActivityRuntimeSnapshot): void;
}

const ActivityRuntimeContext = createContext<ActivityRuntimeContextValue | undefined>(undefined);

export function ActivityRuntimeProvider({ active, children }: { active: boolean; children: ReactNode }): React.JSX.Element {
  const [runtime, setRuntime] = useState<ActivityRuntimeSnapshot>();
  const [permissions, setPermissions] = useState<ActivityPermissionStatus>();
  const [permissionError, setPermissionError] = useState<string>();
  const permissionRequest = useRef(0);
  const runtimeRef = useRef<ActivityRuntimeSnapshot | undefined>(undefined);
  const updateRuntime = useCallback((next: ActivityRuntimeSnapshot): void => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);
  const refresh = useCallback(async (): Promise<ActivityRuntimeSnapshot> => {
    const next = await window.biny.activitySnapshot();
    updateRuntime(next);
    return next;
  }, [updateRuntime]);
  const refreshPermissions = useCallback(async (): Promise<ActivityPermissionStatus> => {
    // 系统读取失败时清掉旧授权显示；旧快照不能证明当前仍已授权。
    const request = ++permissionRequest.current;
    try {
      const next = await window.biny.activityPermissions();
      if (request === permissionRequest.current) {
        setPermissions(next);
        setPermissionError(undefined);
      }
      return next;
    } catch (error) {
      if (request === permissionRequest.current) {
        setPermissions(undefined);
        setPermissionError(error instanceof Error ? error.message : "读取系统权限失败");
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (runtimeRef.current === undefined) void refresh().catch(() => undefined);
    void refreshPermissions().catch(() => undefined);
    const unsubscribe = window.biny.onActivityEvent((next) => {
      if (!cancelled) updateRuntime(next);
    });
    const interval = window.setInterval(() => {
      void refresh().catch(() => undefined);
      void refreshPermissions().catch(() => undefined);
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [active, refresh, refreshPermissions, updateRuntime]);

  const value = useMemo(() => ({ runtime, permissions, permissionError, refresh, refreshPermissions, updateRuntime }), [permissions, permissionError, refresh, refreshPermissions, runtime, updateRuntime]);
  return <ActivityRuntimeContext.Provider value={value}>{children}</ActivityRuntimeContext.Provider>;
}

// 这个 hook 与 provider 共享同一个 context；拆成多个文件只为规避 Fast Refresh 检查会增加设置层的间接关系。
// eslint-disable-next-line react-refresh/only-export-components
export function useActivityRuntime(): ActivityRuntimeContextValue {
  const value = useContext(ActivityRuntimeContext);
  if (!value) throw new Error("useActivityRuntime 必须在 ActivityRuntimeProvider 内使用");
  return value;
}
