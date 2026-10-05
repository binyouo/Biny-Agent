import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { changeSessionGoal } from "../src/desktop/renderer/src/components/workspace/sessionGoalControl.js";
import { SessionRecorder } from "../src/session/recorder.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-desktop-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-project-"));
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async () => { requests += 1; throw new Error("A paused goal must not request a model."); }) as typeof fetch;
let manager: DesktopAgentManager | undefined;
try {
  const storage = new DesktopUserDataStore(root);
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const credentials = new Map<string, string>();
  const configStore = createFileConfigStore(root, { globalDir: root, credentialStore: {
    persistent: true, get: async (account) => credentials.get(account), set: async (account, value) => { credentials.set(account, value); }, delete: async (account) => { credentials.delete(account); }
  } });
  await configStore.save({
    ...defaultConfig, defaultModel: "goal-test", providers: { test: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: { "goal-test": { ...defaultConfig.models["deepseek-v4-flash"], provider: "test", model: "goal-test" } },
    checkpoints: { enabled: false }, extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(workspace);
  const dataRoot = await projects.dataRoot(project);
  for (const sessionId of ["goal-session-a", "goal-session-b"]) {
    const recorder = new SessionRecorder(dataRoot, sessionId);
    recorder.record({ type: "user_message", content: "existing session" });
    recorder.record({ type: "assistant_message", content: "ready" });
    await recorder.close();
  }
  const authority = await RuntimeEventAuthority.open(dataRoot, { backfillLegacySessions: false });
  const goals = await SessionGoalStore.open(dataRoot, authority);
  for (const sessionId of ["goal-session-a", "goal-session-b"]) { goals.set(sessionId, "existing goal", { tokenBudget: 1000 }); goals.pause(sessionId); }
  goals.close(); authority.close();
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  const draft = await manager.runSlashCommand(project.id, undefined, "/goal");
  assert.equal(draft.sessionId, undefined, "reading a new draft must not select or mutate an existing session");
  assert.deepEqual(draft.sessionGoal, { action: "get" });
  assert.deepEqual((await manager.runSlashCommand(project.id, undefined, "/goal clear")).sessionGoal, { action: "clear" });
  await assert.rejects(manager.runSlashCommand(project.id, undefined, "/goal pause"), /先用/u);
  const objective = `${"完整目标和约束。".repeat(60)}\n最后一个要求`;
  const changed = await manager.runSlashCommand(project.id, "goal-session-a", `/goal ${objective}`);
  assert.equal(changed.sessionId, "goal-session-a");
  assert.deepEqual(changed.sessionGoal, { action: "set", status: "paused" });
  const projection = await manager.planProjection(project.id, "goal-session-a");
  assert.equal(projection.goal?.objective, objective);
  assert.equal(projection.goal?.status, "paused");
  assert.equal(projection.plans.length, 0, "session goals work with subagents disabled");
  assert.equal((await manager.planProjection(project.id, "goal-session-b")).goal?.objective, "existing goal");
  const editErrors: unknown[] = [];
  const editFeedback = { pending: () => undefined, error: () => undefined, report: (error: unknown) => { editErrors.push(error); } };
  const editGoal = projection.goal!;
  const editedObjective = "界面编辑后的完整目标\n保留第二行约束";
  assert.equal(await changeSessionGoal(editGoal, { operation: "session.goal.set", previousObjective: editGoal.objective, objective: editedObjective }, async (operation, payload) => {
    await manager!.runtimeMutation(project.id, operation, payload);
  }, editFeedback, new AbortController().signal), true);
  const afterEdit = await manager.planProjection(project.id, "goal-session-a");
  assert.equal(afterEdit.goal?.objective, editedObjective);
  assert.equal(afterEdit.goal?.status, "paused", "Editing must not resume a paused goal");
  assert.equal(afterEdit.goal?.tokenBudget, 1000, "Editing must preserve the existing budget");
  assert.equal(await changeSessionGoal(editGoal, { operation: "session.goal.set", previousObjective: editGoal.objective, objective: "迟到的旧编辑" }, async (operation, payload) => {
    await manager!.runtimeMutation(project.id, operation, payload);
  }, editFeedback, new AbortController().signal), false, "A stale editor cannot overwrite the new objective");
  assert.equal(editErrors.length, 1);
  assert.equal((await manager.planProjection(project.id, "goal-session-a")).goal?.objective, editedObjective);
  assert.equal((await manager.planProjection(project.id, "goal-session-b")).goal?.objective, "existing goal");
  await assert.rejects(manager.runtimeMutation(project.id, "session.goal.clear", { sessionId: "goal-session-a", expected: { goalId: "stale-goal", revision: 0 } }), /changed|conflict|stale|mismatch/iu);
  await manager.runtimeMutation(project.id, "session.goal.clear", { sessionId: "goal-session-a", expected: { goalId: afterEdit.goal!.goalId, revision: afterEdit.goal!.revision } });
  assert.equal((await manager.planProjection(project.id, "goal-session-a")).goal, undefined);
  assert.equal((await manager.planProjection(project.id, "goal-session-b")).goal?.objective, "existing goal");
  assert.equal(requests, 0);
} finally {
  await manager?.closeAll();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
console.log("session goal Desktop tests passed");
