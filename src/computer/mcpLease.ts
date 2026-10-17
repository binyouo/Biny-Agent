import { randomUUID } from "node:crypto";
import type { McpToolHost } from "../extensions/mcp.js";

const owners = new WeakMap<McpToolHost, Map<string, ComputerMcpLease>>();

/** 运行时实例的桥接所有权；不代表工具或应用授权。 */
export class ComputerMcpLease {
  readonly id = randomUUID();
  private readonly lifetime = new AbortController();
  private readonly cleanups = new Set<() => Promise<void>>();
  private closePromise?: Promise<void>;

  constructor(private readonly registry: Map<string, ComputerMcpLease>) {
    registry.set(this.id, this);
  }

  get signal(): AbortSignal { return this.lifetime.signal; }

  register(close: () => Promise<void>): () => void {
    this.signal.throwIfAborted();
    this.cleanups.add(close);
    return () => { this.cleanups.delete(close); };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.registry.delete(this.id);
    this.lifetime.abort(new Error("Computer Use runtime lease is closed."));
    const callbacks = [...this.cleanups];
    this.cleanups.clear();
    this.closePromise = Promise.allSettled(callbacks.map(close => Promise.resolve().then(close))).then(results => {
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Computer Use runtime cleanup failed.");
    });
    return this.closePromise;
  }
}

export function createComputerMcpLease(host: McpToolHost): ComputerMcpLease {
  let registry = owners.get(host);
  if (!registry) { registry = new Map(); owners.set(host, registry); }
  return new ComputerMcpLease(registry);
}

export function resolveComputerMcpLease(host: McpToolHost, id: unknown): ComputerMcpLease | undefined {
  // 独立 MCP 客户端没有 Runtime；其资源仍由本地连接关闭负责回收。
  if (id === undefined) return undefined;
  const lease = typeof id === "string" ? owners.get(host)?.get(id) : undefined;
  if (!lease) throw new Error("Computer Use runtime lease is closed or unknown.");
  lease.signal.throwIfAborted();
  return lease;
}
