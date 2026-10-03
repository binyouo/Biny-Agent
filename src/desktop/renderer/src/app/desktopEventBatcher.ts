import type { DesktopAgentEventEnvelope } from "../../../protocol.js";
import { mergeLiveTimelineEvent } from "../sessionTimeline.js";

interface BufferedEvent {
  envelope: DesktopAgentEventEnvelope;
  bytes: number;
  contentBytes: number;
}

interface DesktopEventBatcherOptions {
  maxEvents?: number;
  maxBytes?: number;
  scheduleFlush?(flush: () => void): () => void;
}

const encoder = new TextEncoder();

/** 计时器停滞时仍由预算触发交付；归并只替换连续文本及其最新运行快照。 */
export function createDesktopEventBatcher(onBatch: (batch: DesktopAgentEventEnvelope[]) => void, options: DesktopEventBatcherOptions = {}) {
  const maxEvents = options.maxEvents ?? 128;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const scheduleFlush = options.scheduleFlush ?? ((flush: () => void) => {
    const timer = setTimeout(flush, 16);
    return () => clearTimeout(timer);
  });
  let pending: BufferedEvent[] = [];
  let pendingBytes = 0;
  let cancelFlush: (() => void) | undefined;
  let disposed = false;

  const flush = (): void => {
    cancelFlush?.();
    cancelFlush = undefined;
    if (!pending.length) return;
    const batch = pending.map((entry) => entry.envelope);
    pending = [];
    pendingBytes = 0;
    onBatch(batch);
  };

  return {
    push(envelope: DesktopAgentEventEnvelope): void {
      if (disposed) return;
      const previous = pending.at(-1);
      const merged = previous?.envelope.projectId === envelope.projectId && previous.envelope.primary === envelope.primary && envelope.event
        ? mergeLiveTimelineEvent(previous.envelope.event, envelope.event)
        : undefined;
      const bytes = encoder.encode(JSON.stringify(envelope)).byteLength;
      const contentBytes = envelope.event?.type === "reasoning.delta" || envelope.event?.type === "assistant.delta"
        ? encoder.encode(JSON.stringify(envelope.event.content)).byteLength - 2
        : 0;
      if (merged && previous) {
        const timestampBytes = encoder.encode(JSON.stringify(merged.timestamp)).byteLength
          - encoder.encode(JSON.stringify(envelope.event!.timestamp)).byteLength;
        const mergedBytes = bytes + previous.contentBytes + timestampBytes;
        pendingBytes += mergedBytes - previous.bytes;
        pending[pending.length - 1] = { envelope: { ...envelope, event: merged }, bytes: mergedBytes, contentBytes: contentBytes + previous.contentBytes };
      } else {
        pending.push({ envelope, bytes, contentBytes });
        pendingBytes += bytes;
      }
      if (pending.length >= maxEvents || pendingBytes >= maxBytes) flush();
      else cancelFlush ??= scheduleFlush(flush);
    },
    flush,
    dispose(): void {
      disposed = true;
      cancelFlush?.();
      cancelFlush = undefined;
      pending = [];
      pendingBytes = 0;
    }
  };
}
