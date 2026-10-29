import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(resident = true) {
  const project = { id: "P", path: "/inert/project" };
  let selected: string | undefined = "history";
  let focused = "history";
  let ensures = 0;
  const snapshot = (sessionId: string, isolated = false) => ({ info: { sessionId, workspaceRoot: isolated ? `/inert/worktree/${sessionId}` : project.path }, state: { kind: "idle" as const } });
  const snapshots = new Map([["history", snapshot("history")]]);
  const creations: Array<{ isolation?: string; result: ReturnType<typeof deferred<string>> }> = [];
  const submissions: string[] = [], ensured: Array<string | undefined> = [], released: string[] = [], compactions: string[] = [];
  const commands: Array<{ input: string; sessionId?: string }> = [];
  let ensureGate: ReturnType<typeof deferred<void>> | undefined;
  let submitGate: ReturnType<typeof deferred<void>> | undefined;
  const runtime = {
    isRetired: false,
    getFocusedSessionId: () => focused,
    getSnapshot: (id = focused) => snapshots.get(id)!,
    runtimeSnapshots: () => [...snapshots].map(([sessionId, value]) => ({ sessionId, snapshot: value })),
    async startDraft(isolation?: string) {
      const result = deferred<string>(); creations.push({ isolation, result });
      const id = await result.promise;
      snapshots.set(id, snapshot(id, isolation === "worktree"));
      focused = id; // Actual client applies focus even when this request is stale.
      return snapshots.get(id)!.info;
    },
    async focusSession(id: string) { focused = id; },
    async releaseSessionClaim(id: string) { released.push(id); },
    async ensureSession(options: { sessionId?: string }) {
      ensured.push(options.sessionId); await ensureGate?.promise;
      const id = options.sessionId ?? "shared-fallback";
      if (!snapshots.has(id)) snapshots.set(id, snapshot(id));
      return { sessionId: id, snapshot: snapshots.get(id)! };
    },
    async submitRunForSession(id: string) {
      submissions.push(id); await submitGate?.promise;
      return { accepted: true, result: { runId: "accepted-run", messageId: "accepted-message" } };
    },
    async executeCommand(input: string, _source: string, sessionId?: string) {
      commands.push({ input, sessionId }); return { command: input, title: "command", content: "done" };
    },
    async compactConversation() { compactions.push(focused); return "compacted"; },
    taskList: async () => [], automationList: async () => [], automationPending: async () => [], graphList: async () => [], capabilityList: async () => [], worktreeStatus: async () => []
  };
  const state = { project: () => project, selectedSessionId: () => selected,
    setSelectedSession: async (_projectId: string, id: string | undefined) => { selected = id; }, removeProject: async () => undefined };
  const projects = { requireProject: () => project, refreshStoredProject: async () => project,
    listWorkspaceSessions: async () => ({ sessions: [] }),
    openSession: async (_project: unknown, id: string) => ({ session: { id }, events: [], liveEvents: [] }) };
  type Args = ConstructorParameters<typeof DesktopAgentManager>;
  const manager = new DesktopAgentManager(state as unknown as Args[0], projects as unknown as Args[1],
    { load: async () => { throw new Error("no model needed"); } } as unknown as Args[2], () => undefined);
  const internal = manager as unknown as {
    runtimes: Map<string, unknown>; draftSessionIds: Map<string, string>;
    ensureRuntime: () => Promise<unknown>; closeManagedRuntime: () => Promise<void>;
    scheduleSessionRead: () => void; requireConfiguredModel: () => Promise<void>;
  };
  const managed = { runtime };
  if (resident) internal.runtimes.set("P", managed);
  internal.ensureRuntime = async () => { ensures++; internal.runtimes.set("P", managed); return managed; };
  internal.closeManagedRuntime = async () => undefined;
  internal.scheduleSessionRead = () => undefined;
  internal.requireConfiguredModel = async () => undefined;
  return { manager, creations, submissions, ensured, released, commands, compactions, internal, runtime, selected: () => selected, ensures: () => ensures,
    setEnsureGate: (gate: typeof ensureGate) => { ensureGate = gate; }, setSubmitGate: (gate: typeof submitGate) => { submitGate = gate; } };
}

test("pending isolated draft rejects undefined send before any shared admission", async () => {
  const f = fixture(); const opening = f.manager.startDraft("P", "worktree"); await turn();
  await assert.rejects(f.manager.sendPrompt("P", undefined, "modify files", []), /准备|创建失败/u);
  assert.deepEqual(f.ensured, []); assert.deepEqual(f.submissions, []);
  f.creations[0]!.result.resolve("isolated");
  assert.equal((await opening).runtime?.info.sessionId, "isolated");
  await f.manager.sendPrompt("P", undefined, "modify files", []);
  assert.deepEqual(f.ensured, ["isolated"]); assert.deepEqual(f.submissions, ["isolated"]);
});

test("failed isolation stays blocked until explicit successful new draft", async () => {
  const f = fixture(false); const opening = f.manager.startDraft("P", "worktree");
  const rejected = assert.rejects(opening, /creation failed/u);
  await turn(); f.creations[0]!.result.reject(new Error("creation failed")); await rejected;
  await assert.rejects(f.manager.sendPrompt("P", undefined, "modify files", []), /准备|创建失败/u);
  assert.deepEqual(f.ensured, []);
  const retry = f.manager.startDraft("P", "shared"); await turn(); f.creations[1]!.result.resolve("shared-explicit"); await retry;
  await f.manager.sendPrompt("P", undefined, "modify files", []); assert.deepEqual(f.submissions, ["shared-explicit"]);
});

test("latest draft owns map and snapshot even when older client focus completes last", async () => {
  const f = fixture(); const first = f.manager.startDraft("P", "worktree"); const rejected = assert.rejects(first, /目标已变更/u); await turn();
  const second = f.manager.startDraft("P", "worktree"); await turn(); f.creations[1]!.result.resolve("latest"); await second;
  f.creations[0]!.result.resolve("stale"); await rejected;
  assert.equal(f.runtime.getFocusedSessionId(), "stale");
  assert.equal(f.internal.draftSessionIds.get("P"), "latest");
  assert.equal((await f.manager.workspaceSnapshot("P")).runtime?.info.sessionId, "latest");
  await f.manager.sendPrompt("P", undefined, "correct worktree", []); assert.deepEqual(f.submissions, ["latest"]);
});

for (const action of ["navigation", "dispose"] as const) {
  test(`${action} retires pending draft without restoring it on late completion`, async () => {
    const f = fixture(); const opening = f.manager.startDraft("P", "worktree"); const rejected = assert.rejects(opening, /目标已变更/u); await turn();
    if (action === "navigation") await f.manager.openSession("P", "other-history"); else await f.manager.disposeProject("P");
    f.creations[0]!.result.resolve("stale"); await rejected;
    assert.equal(f.internal.draftSessionIds.has("P"), false); assert.deepEqual(f.submissions, []);
    if (action === "navigation") {
      await f.manager.sendPrompt("P", undefined, "fresh blank draft", []);
      assert.deepEqual(f.submissions, ["shared-fallback"], "retired identity does not permanently block a fresh shared draft");
    }
  });
}

test("shared preparation begun before isolation intent cannot submit after the target changes", async () => {
  const f = fixture(); const gate = deferred<void>(); f.setEnsureGate(gate);
  const sending = f.manager.sendPrompt("P", undefined, "old blank send", []); const rejected = assert.rejects(sending, /目标已变更/u); await turn();
  const opening = f.manager.startDraft("P", "worktree"); await turn(); gate.resolve(); await rejected;
  assert.deepEqual(f.submissions, []); f.creations[0]!.result.resolve("isolated"); await opening;
});

test("already submitted run survives but late receipt cannot replace a newer isolated draft", async () => {
  const f = fixture(); const gate = deferred<void>(); f.setSubmitGate(gate);
  const sending = f.manager.sendPrompt("P", undefined, "already admitted", []); await turn(); assert.deepEqual(f.submissions, ["shared-fallback"]);
  const opening = f.manager.startDraft("P", "worktree"); await turn(); f.creations[0]!.result.resolve("isolated"); await opening;
  gate.resolve(); assert.equal((await sending).sessionId, "shared-fallback");
  assert.equal(f.selected(), "history"); assert.equal(f.internal.draftSessionIds.get("P"), "isolated");
});

test("shared blank draft without resident runtime remains lightweight", async () => {
  const f = fixture(false); await f.manager.startDraft("P", "shared");
  assert.equal(f.ensures(), 0); assert.equal(f.creations.length, 0);
  await f.manager.sendPrompt("P", undefined, "first send", []); assert.deepEqual(f.submissions, ["shared-fallback"]);
});

test("pending draft blocks slash and compact; ready goal and review explicitly target isolation", async () => {
  const f = fixture(); const opening = f.manager.startDraft("P", "worktree"); await turn();
  for (const input of ["/goal set isolated goal", "/review", "/subagent task"]) await assert.rejects(f.manager.runSlashCommand("P", undefined, input), /准备|创建失败/u);
  await assert.rejects(f.manager.compact("P"), /准备|草稿/u);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.compactions, []);
  f.creations[0]!.result.resolve("isolated"); await opening; await f.runtime.focusSession("history");
  await f.manager.runSlashCommand("P", undefined, "/goal set isolated goal"); await f.manager.runSlashCommand("P", undefined, "/review");
  assert.deepEqual(f.commands.map(command => command.sessionId), ["isolated", "isolated"]);
  assert.deepEqual(f.ensured, []); await assert.rejects(f.manager.compact("P"), /草稿/u);
});

test("a slash command waiting for model readiness loses admission to a newer draft", async () => {
  const f = fixture(); const ready = deferred<void>();
  f.internal.requireConfiguredModel = async () => await ready.promise;
  const command = f.manager.runSlashCommand("P", undefined, "/review");
  const rejected = assert.rejects(command, /目标已变更/u);
  await turn(); const opening = f.manager.startDraft("P", "worktree"); await turn();
  ready.resolve(); await rejected;
  assert.deepEqual(f.commands, []);
  f.creations[0]!.result.resolve("isolated"); await opening;
});

for (const explicit of [false, true]) {
  test(`late accepted receipt cannot delete a newer owner reusing the same draft ID (explicit=${explicit})`, async () => {
    const f = fixture(); const opening = f.manager.startDraft("P", "worktree"); await turn();
    f.creations[0]!.result.resolve("same-id"); await opening;
    const gate = deferred<void>(); f.setSubmitGate(gate);
    const sending = f.manager.sendPrompt("P", explicit ? "same-id" : undefined, "already dispatched", []); await turn();
    assert.deepEqual(f.submissions, ["same-id"]);
    await f.manager.startDraft("P", "worktree"); // The runtime cache still reports this unsubmitted draft idle.
    assert.equal(f.creations.length, 1, "same idle isolation draft is reused");
    gate.resolve(); assert.equal((await sending).sessionId, "same-id");
    assert.equal(f.internal.draftSessionIds.get("P"), "same-id", "only the current admission may consume the draft binding");
  });
}
