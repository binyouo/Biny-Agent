import { promises as fs } from "node:fs";

export interface SessionReadMetrics { bytesRead: number; parsedRows: number; durationMs: number }

/** Observe actual descriptor reads and JSON parses; no model or storage test seam. */
export async function measureSessionRead<T>(action: () => Promise<T>): Promise<{ value: T; metrics: SessionReadMetrics }> {
  const originalOpen = fs.open;
  const originalParse = JSON.parse;
  const metrics: SessionReadMetrics = { bytesRead: 0, parsedRows: 0, durationMs: 0 };
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    handle.read = new Proxy(handle.read, {
      async apply(target, receiver, parameters: unknown[]) {
        const result = await Reflect.apply(target, receiver, parameters) as { bytesRead: number };
        metrics.bytesRead += result.bytesRead;
        return result;
      }
    });
    return handle;
  };
  JSON.parse = (...args: Parameters<typeof JSON.parse>): unknown => {
    metrics.parsedRows += 1;
    return originalParse(...args) as unknown;
  };
  const started = performance.now();
  try { return { value: await action(), metrics }; }
  finally {
    metrics.durationMs = performance.now() - started;
    fs.open = originalOpen;
    JSON.parse = originalParse;
  }
}
