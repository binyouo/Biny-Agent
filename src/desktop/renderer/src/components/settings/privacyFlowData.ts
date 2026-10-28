import type { DesktopMaskRecordSummary } from "../../../../protocol.js";

export interface PrivacyFlowNode { id: string; label: string; count: number }

/** 展示前三项，其余归并；两端计数均来自同一批出站替换记录。 */
export function privacyFlowNodes(records: readonly DesktopMaskRecordSummary[]): { sessions: PrivacyFlowNode[]; providers: PrivacyFlowNode[] } {
  const sessions = new Map<string, PrivacyFlowNode>(), providers = new Map<string, PrivacyFlowNode>();
  for (const record of records) {
    const sessionId = record.sessionId ?? "";
    const source = sessions.get(sessionId) ?? { id: sessionId, label: sessionId ? `会话 ${sessionId.slice(-6)}` : "辅助请求", count: 0 };
    source.count += record.count;
    sessions.set(sessionId, source);
    const target = providers.get(record.provider) ?? { id: record.provider, label: record.provider, count: 0 };
    target.count += record.count;
    providers.set(record.provider, target);
  }
  const compact = (nodes: Map<string, PrivacyFlowNode>): PrivacyFlowNode[] => {
    const sorted = [...nodes.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    if (sorted.length <= 3) return sorted;
    return [...sorted.slice(0, 3), { id: "", label: `另外 ${sorted.length - 3} 项`, count: sorted.slice(3).reduce((sum, node) => sum + node.count, 0) }];
  };
  return { sessions: compact(sessions), providers: compact(providers) };
}
