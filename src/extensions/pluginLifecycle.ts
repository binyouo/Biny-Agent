import type { AgentTurnOutcome } from "../agent/types.js";

export interface PluginTurnMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface PluginBeforeTurnContext {
  workspaceRoot: string;
  sessionId: string;
  userMessage: string;
  useMemories: boolean;
  contributeMemories: boolean;
  signal?: AbortSignal;
  callMcpTool?: PluginMcpToolCaller;
}

export interface PluginAfterTurnContext extends PluginBeforeTurnContext {
  outcome: AgentTurnOutcome;
  messages: readonly PluginTurnMessage[];
}

export interface PluginTurnLifecycle {
  beforeTurn?(context: PluginBeforeTurnContext): string | undefined | Promise<string | undefined>;
  afterTurn?(context: PluginAfterTurnContext): void | Promise<void>;
}

export type PluginMcpToolCaller = (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<unknown>;

export type PluginLifecycleErrorHandler = (pluginPath: string, phase: "beforeTurn" | "afterTurn", error: unknown) => void;

/** Plugin callbacks are optional sidecars: their failures must not change the agent turn outcome. */
export class PluginLifecycleRegistry {
  private readonly lifecycles: Array<{ pluginPath: string; lifecycle: PluginTurnLifecycle }> = [];

  constructor(private readonly onError?: PluginLifecycleErrorHandler) {}

  get hasBeforeTurn(): boolean {
    return this.lifecycles.some(({ lifecycle }) => lifecycle.beforeTurn !== undefined);
  }

  get hasAfterTurn(): boolean {
    return this.lifecycles.some(({ lifecycle }) => lifecycle.afterTurn !== undefined);
  }

  register(lifecycle: PluginTurnLifecycle, pluginPath = "unknown plugin"): void {
    if (typeof lifecycle !== "object" || lifecycle === null
      || (lifecycle.beforeTurn !== undefined && typeof lifecycle.beforeTurn !== "function")
      || (lifecycle.afterTurn !== undefined && typeof lifecycle.afterTurn !== "function")) {
      throw new TypeError("Plugin turn lifecycle must provide beforeTurn or afterTurn callbacks.");
    }
    if (lifecycle.beforeTurn === undefined && lifecycle.afterTurn === undefined) {
      throw new TypeError("Plugin turn lifecycle must provide at least one callback.");
    }
    this.lifecycles.push({ pluginPath, lifecycle });
  }

  async beforeTurn(context: PluginBeforeTurnContext, callMcpTool?: PluginMcpToolCaller): Promise<string[]> {
    const results = await Promise.all(this.lifecycles.map(({ lifecycle, pluginPath }) =>
      this.runCallback(context.signal, callMcpTool, (signal, caller) =>
        lifecycle.beforeTurn?.({ ...context, signal, callMcpTool: caller }), pluginPath, "beforeTurn")));
    return results.flatMap((result) => typeof result === "string" && result.trim()
      ? [result.trim()]
      : []);
  }

  async afterTurn(context: PluginAfterTurnContext, callMcpTool?: PluginMcpToolCaller): Promise<void> {
    await Promise.all(this.lifecycles.map(({ lifecycle, pluginPath }) =>
      this.runCallback(context.signal, callMcpTool, (signal, caller) =>
        lifecycle.afterTurn?.({ ...context, signal, callMcpTool: caller,
          outcome: structuredClone(context.outcome), messages: context.messages.map(message => ({ ...message }))
        }), pluginPath, "afterTurn")));
  }

  /** Retire host-mediated authority, not arbitrary in-process plugin side effects. */
  private async runCallback<T>(
    parent: AbortSignal | undefined,
    callMcpTool: PluginMcpToolCaller | undefined,
    invoke: (signal: AbortSignal, caller: PluginMcpToolCaller | undefined) => T | Promise<T>,
    pluginPath: string,
    phase: "beforeTurn" | "afterTurn"
  ): Promise<T | undefined> {
    const owner = new AbortController();
    let active = true;
    const pending = new Set<Promise<unknown>>();
    let wake: () => void = () => undefined;
    const retired = new Promise<undefined>(resolve => { wake = () => resolve(undefined); });
    const retire = (): void => {
      if (!active) return;
      active = false;
      owner.abort(parent?.reason ?? new Error("Plugin callback scope has ended."));
      wake();
    };
    parent?.addEventListener("abort", retire, { once: true });
    if (parent?.aborted) retire();
    const caller: PluginMcpToolCaller | undefined = callMcpTool && ((server, tool, args, signal) => {
      // Schedule only after recording ownership, including synchronous caller failures.
      const operation = Promise.resolve().then(async () => {
        owner.signal.throwIfAborted();
        const combined = signal ? AbortSignal.any([owner.signal, signal]) : owner.signal;
        combined.throwIfAborted();
        return await callMcpTool(server, tool, args, combined);
      });
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    });
    const operation = Promise.resolve().then(() => {
      if (!active) return undefined;
      return invoke(owner.signal, caller);
    }).catch(error => {
      // Late callbacks stay observed, but cannot publish diagnostics into a later turn.
      if (active) this.reportError(pluginPath, phase, error);
      return undefined;
    });
    try {
      const result = await Promise.race([operation, retired]);
      return active ? result : undefined;
    } finally {
      retire();
      parent?.removeEventListener("abort", retire);
      // Never use a deadline to release a still-running admitted tool or its audit writes.
      await Promise.allSettled([...pending]);
    }
  }

  private reportError(pluginPath: string, phase: "beforeTurn" | "afterTurn", error: unknown): void {
    try { this.onError?.(pluginPath, phase, error); }
    catch { /* Error reporting cannot change a turn outcome. */ }
  }
}
