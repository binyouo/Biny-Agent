/** 统一订阅摘要变更，不为每个会话行单独请求后台。 */
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DesktopThreadBriefRequest, DesktopThreadBriefSnapshot } from "../../../threadBriefProtocol.js";
import { ThreadBriefContext } from "./context.js";
export function ThreadBriefProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopThreadBriefSnapshot>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const request = useCallback(async (input: DesktopThreadBriefRequest) => {
    const id = ++generation.current;
    try {
      const next = await window.biny.threadBriefRequest(input);
      if (id === generation.current) { setSnapshot((current) => ({ ...next, config: current && JSON.stringify(current.config) === JSON.stringify(next.config) ? current.config : next.config })); setError(undefined); }
      return next;
    } catch (reason) {
      if (id === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, []);
  useEffect(() => {
    const refresh = (): void => { void request({ action: "overview" }).catch(() => undefined); };
    const unsubscribe = window.biny.onThreadBriefChanged(refresh);
    refresh();
    return () => { unsubscribe(); generation.current += 1; };
  }, [request]);
  const value = useMemo(() => ({ snapshot, error, request }), [snapshot, error, request]);
  return <ThreadBriefContext.Provider value={value}>{children}</ThreadBriefContext.Provider>;
}
