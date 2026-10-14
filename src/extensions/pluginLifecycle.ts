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
    const isolatedContext = { ...context, callMcpTool };
    const results = await Promise.all(this.lifecycles.map(async ({ lifecycle, pluginPath }) => {
      try {
        return await lifecycle.beforeTurn?.(isolatedContext);
      } catch (error) {
        this.reportError(pluginPath, "beforeTurn", error);
        return undefined;
      }
    }));
    return results.flatMap((result) => typeof result === "string" && result.trim()
      ? [result.trim()]
      : []);
  }

  async afterTurn(context: PluginAfterTurnContext, callMcpTool?: PluginMcpToolCaller): Promise<void> {
    const isolatedContext = {
      ...context,
      messages: context.messages.map((message) => ({ ...message })),
      callMcpTool
    };
    await Promise.all(this.lifecycles.map(async ({ lifecycle, pluginPath }) => {
      try {
        await lifecycle.afterTurn?.(isolatedContext);
      } catch (error) {
        this.reportError(pluginPath, "afterTurn", error);
      }
    }));
  }

  private reportError(pluginPath: string, phase: "beforeTurn" | "afterTurn", error: unknown): void {
    try { this.onError?.(pluginPath, phase, error); }
    catch { /* Error reporting cannot change a turn outcome. */ }
  }
}
