/**
 * 会话消息树的纯数据投影。
 *
 * 这里刻意不依赖文件系统、Node API 或回放实现，renderer 也能复用同一套活动版本规则。
 * 持久化回放负责把它接到模型消息上，时间线只使用消息 ID 和事件归属。
 */
import type { AgentMessage } from "../agent/core/types.js";
import type { SessionEvent } from "./recorder.js";

export interface SessionMessageNode {
  id: string;
  parentId?: string;
  slotId?: string;
  eventIndex: number;
  message: AgentMessage;
}

export interface SessionMessageReference {
  id?: string;
  index: number;
  parentId?: string;
  slotId?: string;
}

/** metadata 更新是追加事实，不复制消息正文；恢复时只合并属于该消息的补丁。 */
export function sessionMessageMetadata(events: readonly SessionEvent[], messageId: string): Record<string, unknown> {
  let exists = false;
  let metadata: Record<string, unknown> = {};
  for (const event of events) {
    if ((event.type === "user_message" || event.type === "agent_message" || event.type === "assistant_message")
      && !("auditOnly" in event && event.auditOnly) && event.messageId === messageId && !exists) {
      exists = true;
      metadata = { ...event.metadata };
    }
    if (!exists || event.type !== "message_metadata" || event.messageId !== messageId) continue;
    metadata = mergeMessageMetadata(metadata, event.metadata);
  }
  return metadata;
}

/** 一次扫描只投影本次需要的消息；结果属于调用方，不缓存可原地追加的事件数组。 */
export function sessionMessageMetadataForIds(
  events: readonly SessionEvent[],
  messageIds: ReadonlySet<string>
): ReadonlyMap<string, Record<string, unknown>> {
  const metadataById = new Map<string, Record<string, unknown>>();
  if (!messageIds.size) return metadataById;
  for (const event of events) {
    if (event.type === "message_metadata") {
      const previous = metadataById.get(event.messageId);
      // 首条真实消息之前的补丁无效，重复消息也不能重置已合并的 metadata。
      if (previous !== undefined) metadataById.set(event.messageId, mergeMessageMetadata(previous, event.metadata));
    } else if ((event.type === "user_message" || event.type === "agent_message" || event.type === "assistant_message")
      && !("auditOnly" in event && event.auditOnly) && event.messageId !== undefined
      && messageIds.has(event.messageId) && !metadataById.has(event.messageId)) {
      metadataById.set(event.messageId, { ...event.metadata });
    }
  }
  return metadataById;
}

function mergeMessageMetadata(previous: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const previousUsage = previous.usage;
  const metadata = { ...previous, ...patch };
  // usage 只合并自身一层；其他嵌套字段由新补丁整体替换。
  if (previousUsage || patch.usage) {
    metadata.usage = { ...Object(previousUsage || {}), ...Object(patch.usage || {}) };
  }
  return metadata;
}

/** 新格式保留 canonical 消息的父子关系；旧事件没有 ID 时由时间线继续按扁平事件展示。 */
export function sessionMessageTree(events: readonly SessionEvent[]): SessionMessageNode[] {
  return events.flatMap((event, eventIndex): SessionMessageNode[] => {
    if (event.type === "user_message" && !event.auditOnly) {
      if (!event.messageId) return [];
      return [{
        id: event.messageId,
        parentId: event.parentMessageId,
        slotId: event.slotId ?? event.messageId,
        eventIndex,
        message: { role: "user", content: event.content }
      }];
    }
    if (event.type === "agent_message") {
      if (!event.messageId) return [];
      return [{
        id: event.messageId,
        parentId: event.parentMessageId,
        slotId: event.slotId ?? event.messageId,
        eventIndex,
        message: event.message
      }];
    }
    return [];
  });
}

/** 取得当前消息树的活动路径，版本切换标记优先于事件顺序。 */
export function activeSessionMessageIds(
  events: readonly SessionEvent[],
  nodes: readonly SessionMessageNode[] = sessionMessageTree(events)
): ReadonlySet<string> {
  if (!nodes.length) return new Set<string>();
  const selectedSlots = new Map<string, string>();
  for (const event of events) {
    if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathFor = (leaf: SessionMessageNode): Set<string> => {
    const path = new Set<string>();
    let current: SessionMessageNode | undefined = leaf;
    while (current && !path.has(current.id)) {
      path.add(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    return path;
  };
  // 普通对话只需从末节点走一次；版本选择按祖先累计命中数，避免每个节点重建整条路径。
  if (!selectedSlots.size) return pathFor(nodes[nodes.length - 1]!);
  const selected = new Set(selectedSlots.values());
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (counts.has(node.id)) continue;
    const trail: SessionMessageNode[] = [];
    const positions = new Map<string, number>();
    let current: SessionMessageNode | undefined = node;
    while (current && !counts.has(current.id) && !positions.has(current.id)) {
      positions.set(current.id, trail.length);
      trail.push(current);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    let count = current ? counts.get(current.id) ?? 0 : 0;
    const cycleStart = current ? positions.get(current.id) : undefined;
    if (cycleStart !== undefined) {
      // 损坏或外部导入的环仍沿用有限路径语义；环内每个节点可达同一组选择。
      const cycle = trail.splice(cycleStart);
      count = cycle.reduce((sum, item) => sum + Number(selected.has(item.id)), 0);
      for (const item of cycle) counts.set(item.id, count);
    }
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      const item = trail[index]!;
      count += Number(selected.has(item.id));
      counts.set(item.id, count);
    }
  }
  const leaf = [...nodes].reverse().find((node) => counts.get(node.id) === selected.size) ?? nodes.at(-1);
  if (!leaf) return new Set<string>();
  return pathFor(leaf);
}

/** 保留活动消息对应的工具、终态和扁平投影，避免旧版本在回放时重新出现。 */
export function activeSessionEventsForPath(events: readonly SessionEvent[]): SessionEvent[] {
  const recordedEvents = [...events];
  const nodes = sessionMessageTree(recordedEvents);
  const messageTreeIds = new Set(nodes.map((node) => node.id));
  const activeIds = activeSessionMessageIds(recordedEvents, nodes);
  if (!activeIds.size) return recordedEvents;
  const activeRuns = new Set(
    nodes
      .filter((node) => activeIds.has(node.id))
      .map((node) => recordedEvents[node.eventIndex]?.runtime?.runId)
      .filter((runId): runId is string => runId !== undefined)
  );
  return recordedEvents.filter((event) => {
    if (event.type === "message_version_selected") return true;
    if (event.type === "user_message" || event.type === "agent_message") {
      return event.messageId === undefined || activeIds.has(event.messageId);
    }
    if ((event.type === "assistant_message" || event.type === "message_metadata") && event.messageId !== undefined) {
      // 旧会话可能只有 assistant_message，没有对应的 canonical agent_message 节点；
      // 这类事件不参与版本筛选，不能因为带了 messageId 就被误删。
      return !messageTreeIds.has(event.messageId) || activeIds.has(event.messageId);
    }
    if (event.runtime?.runId !== undefined && activeRuns.size > 0) {
      return activeRuns.has(event.runtime.runId);
    }
    return true;
  });
}
