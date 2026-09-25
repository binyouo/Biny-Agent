/** Desktop Activity REST 只转接现有采集宿主和配置权威，不另起采集器。 */
import type { AgentConfigStore } from "../../../config/store.js";
import { resolveToolModel } from "../../../llm/toolModel.js";
import type { EmbeddingModelRuntime } from "../../../llm/embedding/types.js";
import type { ActivityAnalyzerDeps } from "../../../activity/analyzer.js";
import type { ActivityHttpApiDependencies } from "../../../activity/httpServer.js";
import type { ActivityRecorderService } from "./ActivityRecorderService.js";

export function createDesktopActivityHttpDependencies(options: {
  agentDir?: string;
  activity: ActivityRecorderService;
  configStore: AgentConfigStore;
  writeMemories?: ActivityAnalyzerDeps["writeMemories"];
  onAnalyzed?: ActivityAnalyzerDeps["onAnalyzed"];
  getEmbeddingRuntime?: () => Promise<EmbeddingModelRuntime | undefined>;
  openPermissions?: (pane: "screen-recording" | "accessibility") => Promise<void>;
}): ActivityHttpApiDependencies {
  const setEnabled = async (enabled: boolean): Promise<void> => {
    const current = await options.activity.settingsSnapshot();
    await options.activity.updateSettings({ enabled }, current.configRevision);
  };
  return {
    agentDir: options.agentDir,
    loadSettings: async () => (await options.configStore.load()).activity,
    setConfig: async (patch) => {
      const current = await options.activity.settingsSnapshot();
      return (await options.activity.updateSettings(patch, current.configRevision)).activity;
    },
    getModel: async () => resolveToolModel(await options.configStore.load()),
    getRuntimeSnapshot: () => options.activity.snapshot(),
    getOperationSignal: () => options.activity.getOperationSignal(),
    start: async () => await setEnabled(true),
    stop: async () => await setEnabled(false),
    clear: async () => await options.activity.clear(),
    writeMemories: options.writeMemories,
    onAnalyzed: options.onAnalyzed,
    getEmbeddingRuntime: options.getEmbeddingRuntime,
    openPermissions: options.openPermissions
  };
}
