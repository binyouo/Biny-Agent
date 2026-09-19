/**
 * 渲染层实时事件的会话缓冲。
 *
 * 草稿会话首发时，message.user / run.started 等头部事件会在 receipt 返回、渲染层选中
 * 新会话之前广播；按「当前选中会话」过滤会把它们永久丢掉，historicalPrefix 因此失去
 * 对齐锚点，同一回合会被历史和实时各渲染一遍。未命中当前会话的事件先进这里按会话
 * 暂存，选中后原序回放；若文档已带着该会话的完整 liveEvents 打开（openSession 的
 * 主进程桶必然是超集），缓冲整体作废，避免同一批事件被折叠两次。
 */
const DEFAULT_LIMIT = 500;

export interface SessionEventBuffer<T> {
  hold(sessionId: string, event: T): void;
  /** 取出并清空该会话的缓冲；`discard` 为 true 时只清空不返回（文档已覆盖缓冲内容）。 */
  take(sessionId: string, discard?: boolean): T[];
}

export function createSessionEventBuffer<T>(limit: number = DEFAULT_LIMIT): SessionEventBuffer<T> {
  const buckets = new Map<string, T[]>();
  return {
    hold(sessionId, event) {
      const bucket = buckets.get(sessionId);
      if (bucket) {
        bucket.push(event);
        if (bucket.length > limit) bucket.splice(0, bucket.length - limit);
        return;
      }
      buckets.set(sessionId, [event]);
    },
    take(sessionId, discard = false) {
      const bucket = buckets.get(sessionId);
      if (!bucket) return [];
      buckets.delete(sessionId);
      return discard ? [] : bucket;
    }
  };
}
