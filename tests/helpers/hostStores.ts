import { defaultConfig } from "../../src/config/schema.js";
import { CapabilityStore } from "../../src/runtime/CapabilityStore.js";
import { ManagedProcessService } from "../../src/runtime/ManagedProcessService.js";
import { HeartbeatScheduler } from "../../src/agent/context/heartbeat.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { RuntimeEventAuthority } from "../../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../../src/runtime/TaskRunStore.js";
import { GoalGraphStore } from "../../src/runtime/GoalGraphStore.js";
import { AutomationStore } from "../../src/runtime/AutomationScheduler.js";
import { SessionGoalStore } from "../../src/runtime/SessionGoalStore.js";

/** Narrow Host fixtures still use real stores and their shared SQLite authority. */
export async function createHostTestStores(root?: string, authority?: RuntimeEventAuthority) {
  const temporary = root === undefined;
  root ??= await mkdtemp(path.join(os.tmpdir(), "biny-host-stores-"));
  const runtimeAuthority = authority ?? await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  if (!authority) after(async () => {
    runtimeAuthority.close();
    if (temporary) await rm(root!, { recursive: true, force: true });
  });
  const managedProcesses = new ManagedProcessService({ workspaceRoot: root, persistenceRoot: root });
  const heartbeat = new HeartbeatScheduler({ configDir: root, enabled: false, run: () => { throw new Error("Unexpected heartbeat execution"); } });
  after(async () => { heartbeat.stop(); await managedProcesses.close(); });
  return {
    config: structuredClone(defaultConfig),
    capabilities: await CapabilityStore.open(root, runtimeAuthority),
    managedProcesses,
    heartbeat,
    hasBackgroundWork: () => false,
    runtimeAuthority,
    taskRuns: await DurableTaskRunStore.open(root, runtimeAuthority),
    graphs: await GoalGraphStore.open(root, runtimeAuthority),
    automationStore: await AutomationStore.open(root, runtimeAuthority),
    sessionGoals: await SessionGoalStore.open(root, runtimeAuthority),
    canResumeWorkerTask: async () => false
  };
}
