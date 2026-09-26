/** Desktop Activity REST 只转接现有采集宿主和配置权威，不另起采集器。 */
import type { AgentConfigStore } from "../../../config/store.js";
import { resolveToolModel } from "../../../llm/toolModel.js";
import type { EmbeddingModelRuntime } from "../../../llm/embedding/types.js";
import type { ActivityAnalyzerDeps } from "../../../activity/analyzer.js";
import type { ActivityHttpApiDependencies, ActivityPermissionStatus } from "../../../activity/httpServer.js";
import type { ActivityRecorderService } from "./ActivityRecorderService.js";

export function createDesktopActivityHttpDependencies(options: {
  agentDir?: string;
  activity: ActivityRecorderService;
  configStore: AgentConfigStore;
  writeMemories?: ActivityAnalyzerDeps["writeMemories"];
  onAnalyzed?: ActivityAnalyzerDeps["onAnalyzed"];
  getEmbeddingRuntime?: () => Promise<EmbeddingModelRuntime | undefined>;
  getPermissions?: () => ActivityPermissionStatus | Promise<ActivityPermissionStatus>;
  openPermissions?: (pane: "screen-recording" | "accessibility") => Promise<void>;
}): ActivityHttpApiDependencies {
  return {
    agentDir: options.agentDir,
    loadSettings: () => options.activity.runtimeSettingsSnapshot(),
    setConfig: (patch) => options.activity.updateRuntimeSettings(patch),
    getModel: async () => resolveToolModel(await options.configStore.load()),
    getRuntimeSnapshot: () => options.activity.snapshot(),
    isCaptureRunning: () => options.activity.httpCaptureStatus().running,
    getFrontmost: () => options.activity.httpCaptureStatus().frontmost,
    getPermissions: options.getPermissions,
    getOperationSignal: () => options.activity.getOperationSignal(),
    start: async () => await options.activity.startRuntime(),
    stop: async () => {
      await options.activity.stopRuntime();
      return { running: false };
    },
    clear: async () => await options.activity.clear(),
    writeMemories: options.writeMemories,
    onAnalyzed: options.onAnalyzed,
    getEmbeddingRuntime: options.getEmbeddingRuntime,
    openPermissions: options.openPermissions
  };
}
