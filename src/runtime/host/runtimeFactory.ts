import { createRunConfigStore } from "../oneShot.js";
import type { CommandRuntimeOptions } from "../CommandRuntime.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../InteractiveAgentRuntime.js";
import type { RuntimeHostFactory } from "./types.js";

/** 创建成功但尚未交付 registry 的 runtime，仍由工厂负责失败清理。 */
export function createRuntimeHostFactory(
  workspaceRoot: string,
  getOptions: () => CommandRuntimeOptions,
  initialize?: (host: InteractiveAgentHost) => void | Promise<void>
): RuntimeHostFactory {
  return async (sessionId, options) => {
    const base = getOptions();
    const root = options?.workspaceRoot ?? workspaceRoot;
    const host = await createInteractiveAgentHost(root, {
      ...base,
      worktreeRoot: workspaceRoot,
      configStore: options?.runOptions ? createRunConfigStore(root, options.runOptions, base.configStore) : base.configStore,
      processLifetime: options?.processLifetime ?? base.processLifetime,
      sessionId: options?.fresh ? sessionId : undefined,
      resourceRegistry: options?.resourceRegistry,
      resourceBoot: options?.resourceBoot ?? (options?.resourceRegistry === undefined ? "blocking" : "background")
    });
    try {
      await initialize?.(host);
      if (sessionId !== undefined && !options?.fresh) await host.runtime.resumeSession(sessionId);
      return host;
    } catch (error) {
      try {
        await host.runtime.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Runtime initialization and cleanup failed.", { cause: error });
      }
      throw error;
    }
  };
}
