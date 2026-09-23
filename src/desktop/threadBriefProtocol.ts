/** 对话摘要 IPC 只接受会话和建议 ID，不允许渲染层指定要读取的本地文件。 */
import type { BriefThreadReference, ThreadBriefSettings, ThreadBriefSnapshot } from "../session/threadBriefTypes.js";

export type DesktopThreadBriefRequest =
  | { action: "overview" }
  | { action: "configure"; config: ThreadBriefSettings }
  | { action: "history" }
  | { action: "backfill"; sessionId: string }
  | { action: "status"; sessionId: string; status: "inbox" | "todo" | "done" }
  | { action: "dismiss"; id: string }
  | { action: "revise"; id: string; name: string; brief: string; focus: string; sessionIds: string[] }
  | { action: "rewrite"; id: string; feedback: string }
  | { action: "choose-location"; id: string }
  | { action: "accept"; id: string };

export interface DesktopThreadBriefSnapshot extends ThreadBriefSnapshot {
  history?: BriefThreadReference[];
}
