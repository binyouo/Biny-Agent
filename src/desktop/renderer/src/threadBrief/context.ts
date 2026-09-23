/** 摘要共享状态只供参考已有的设置、对话状态和项目建议位置使用。 */
import { createContext, useContext } from "react";
import type { DesktopThreadBriefRequest, DesktopThreadBriefSnapshot } from "../../../threadBriefProtocol.js";
export interface ThreadBriefContextValue {
  snapshot?: DesktopThreadBriefSnapshot;
  error?: string;
  request(input: DesktopThreadBriefRequest): Promise<DesktopThreadBriefSnapshot>;
}
export const ThreadBriefContext = createContext<ThreadBriefContextValue | undefined>(undefined);
export const useThreadBrief = (): ThreadBriefContextValue | undefined => useContext(ThreadBriefContext);
