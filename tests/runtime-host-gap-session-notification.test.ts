import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product source as data; never import or instantiate the Host client.
const source = readFileSync(new URL("../src/runtime/host/client.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const classes = parsed.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostClient");
assert.equal(classes.length, 1);
const clientClass = classes[0];
assert.ok(clientClass);
function method(name: string): ts.MethodDeclaration {
  const matches = clientClass!.members.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
}
const handler = method("handleClientFrame");
assert.ok(handler.body);
// Extract the unchanged event and gap branches, excluding transport/completion handling.
const branches = ["isEventFrame", "isGapFrame"].map((guard) => {
  const matches = handler.body!.statements.filter((node): node is ts.IfStatement =>
    ts.isIfStatement(node) && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === guard);
  assert.equal(matches.length, 1, guard);
  return matches[0]!.getText(parsed);
});

const names = ["applySnapshot", "applyHostEpoch", "acknowledgeEvents", "applySessionSummaries",
  "noteSessionListRemoval", "refreshFocusedSessionSnapshot", "subscribe", "subscribeAllRuntimeEvents"];
const isolated = stripTypeScriptTypes(
  `class Projection { handle(frame: unknown) { ${branches.join("\n")} } ${names.map((name) => method(name).getText(parsed)).join("\n")} } Projection.prototype;`,
  { mode: "strip" }
);
interface Snapshot { info: { sessionId: string }; revision: number; state: { kind: string } }
interface Update { snapshot: Snapshot; event?: { type: string } }
interface Summary { sessionId: string; snapshot: Snapshot; primary: boolean; lastActiveAt: number }
interface Frame { kind: "gap" | "event"; hostEpoch: string; sequence: number; snapshot?: Snapshot; sessions?: Summary[]; update?: Update }
interface Methods {
  handle(frame: Frame): void;
  applySnapshot(snapshot: Snapshot, sequence: number, epoch?: string, focused?: boolean): void;
  applyHostEpoch(epoch: string): void;
  acknowledgeEvents(sequence: number, epoch: string): void;
  applySessionSummaries(sessions: Summary[] | undefined, sequence: number): void;
  noteSessionListRemoval(sessionId: string): void;
  refreshFocusedSessionSnapshot(): void;
  subscribe(listener: (update: Update) => void): () => void;
  subscribeAllRuntimeEvents(listener: (update: Update) => void): () => void;
}
interface State extends Methods {
  focusedSessionId?: string;
  hostEpoch: string;
  consumedHostEpoch: string;
  consumedSequence: number;
  sequence: number;
  snapshots: Map<string, Snapshot>;
  snapshotSequences: Map<string, number>;
  runtimeSessions: Summary[];
  snapshot?: Snapshot;
  pendingUpdates: Update[];
  listeners: Set<(update: Update) => void>;
  allListeners: Set<(update: Update) => void>;
  sessionListReads: Set<{ snapshotWrites: Set<string>; summaryWrites: Set<string>; removals: Set<string> }>;
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
// Only inert guards and a history bound are injected; no transport, timers or product imports.
const methods = runInNewContext(isolated, {
  isEventFrame: (frame: unknown) => record(frame).kind === "event",
  isGapFrame: (frame: unknown) => record(frame).kind === "gap",
  eventHistoryLimit: 4_000
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Methods;
const snap = (id: string, revision = 1, kind = "idle"): Snapshot =>
  ({ info: { sessionId: id }, revision, state: { kind } });
const summaries = (...values: Snapshot[]): Summary[] =>
  values.map((snapshot, index) => ({ sessionId: snapshot.info.sessionId, snapshot, primary: index === 0, lastActiveAt: 1 }));
function fixture(focus = "b") {
  const state = Object.create(methods) as State;
  Object.assign(state, {
    focusedSessionId: focus, hostEpoch: "epoch-a", consumedHostEpoch: "epoch-a",
    consumedSequence: 1, sequence: 1, snapshots: new Map(), snapshotSequences: new Map(),
    runtimeSessions: [], pendingUpdates: [], listeners: new Set(), allListeners: new Set(), sessionListReads: new Set()
  });
  state.applySessionSummaries(summaries(snap("a"), snap("b", 1, "runs")), 1);
  return state;
}
function gap(state: State, values = [snap("a", 2), snap("b", 2, "permission")], sequence = 5, epoch = "epoch-a"): void {
  state.handle({ kind: "gap", hostEpoch: epoch, sequence, snapshot: values[0]!, sessions: summaries(...values) });
}

for (const focus of ["a", "b"]) {
  test(`gap notifies all sessions once and only focused ${focus}`, () => {
    const state = fixture(focus);
    const all: Update[] = [], focused: Update[] = [];
    state.subscribeAllRuntimeEvents((update) => all.push(update));
    state.subscribe((update) => focused.push(update));
    gap(state);
    assert.deepEqual(all.map((update) => update.snapshot.info.sessionId), ["a", "b"]);
    assert.deepEqual(focused.map((update) => update.snapshot.info.sessionId), [focus]);
    assert.equal(all[1]?.snapshot.state.kind, "permission");
    assert.ok(all.every((update) => update.event === undefined));
    assert.equal(state.consumedSequence, 5);
    assert.equal(state.consumedHostEpoch, "epoch-a");
    assert.equal(state.focusedSessionId, focus);
  });
}

test("gap notifications use newer adopted per-session snapshots without regressing cursors", () => {
  const state = fixture();
  const newer = snap("b", 9, "permission");
  state.applySnapshot(newer, 9);
  state.acknowledgeEvents(9, "epoch-a");
  const all: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  gap(state);
  assert.equal(all.find((update) => update.snapshot.info.sessionId === "b")?.snapshot, newer);
  assert.equal(state.snapshots.get("b"), newer);
  assert.equal(state.snapshotSequences.get("b"), 9);
  assert.equal(state.consumedSequence, 9);
  assert.equal(state.sequence, 9);
});

test("gap acknowledgment suppresses old duplicate events but allows new live events", () => {
  const state = fixture();
  const all: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  gap(state);
  const count = all.length;
  state.handle({ kind: "event", hostEpoch: "epoch-a", sequence: 5,
    update: { snapshot: snap("b"), event: { type: "run.completed" } } });
  assert.equal(all.length, count);
  state.handle({ kind: "event", hostEpoch: "epoch-a", sequence: 6,
    update: { snapshot: snap("b", 3), event: { type: "run.completed" } } });
  assert.equal(all.length, count + 1);
  assert.equal(all.at(-1)?.event?.type, "run.completed");
  assert.equal(state.consumedSequence, 6);
});

test("new epoch clears old buffers and observations before notifying reconciled sessions", () => {
  const state = fixture();
  state.pendingUpdates.push({ snapshot: snap("b", 80), event: { type: "old.notice" } });
  state.applySnapshot(snap("b", 80), 80);
  const all: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  gap(state, [snap("a", 0), snap("b", 0)], 2, "epoch-b");
  assert.deepEqual(all.map((update) => update.snapshot.revision), [0, 0]);
  assert.equal(state.hostEpoch, "epoch-b");
  assert.equal(state.consumedHostEpoch, "epoch-b");
  assert.equal(state.consumedSequence, 2);
  assert.equal(state.snapshotSequences.get("b"), 2);
  assert.ok(state.pendingUpdates.every((update) => update.event === undefined));
});

test("unsubscribed focused session buffers gap state and replays latest cache once", () => {
  const state = fixture();
  gap(state);
  state.applySnapshot(snap("b", 3, "idle"), 6);
  const focused: Update[] = [];
  const stop = state.subscribe((update) => focused.push(update));
  assert.equal(focused.length, 1);
  assert.equal(focused[0]?.snapshot.revision, 3);
  assert.equal(focused[0]?.event, undefined);
  assert.equal(state.pendingUpdates.length, 0);
  stop();
  state.subscribe((update) => focused.push(update));
  assert.equal(focused.length, 1);
});

test("gap buffering stays bounded without losing retained ordinary notifications", () => {
  const state = fixture();
  const retained = { snapshot: snap("b"), event: { type: "retained.notice" } };
  state.pendingUpdates.push(...Array.from({ length: 4_000 }, () => retained));
  gap(state);
  assert.equal(state.pendingUpdates.length, 4_000);
  assert.equal(state.pendingUpdates[0]?.event?.type, "retained.notice");
  assert.equal(state.pendingUpdates.at(-1)?.event, undefined);
  assert.equal(state.pendingUpdates.at(-1)?.snapshot.revision, 2);
});

test("legacy gap without summaries notifies its snapshot and leaves unrelated cache alone", () => {
  const state = fixture("a");
  const all: Update[] = [], focused: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  state.subscribe((update) => focused.push(update));
  state.handle({ kind: "gap", hostEpoch: "epoch-a", sequence: 5, snapshot: snap("a", 2) });
  assert.deepEqual(all.map((update) => update.snapshot.info.sessionId), ["a"]);
  assert.equal(focused.length, 1);
  assert.equal(state.snapshots.get("b")?.revision, 1);
});

test("removed focused session falls back to primary without resurrecting removed snapshots", () => {
  const state = fixture();
  const all: Update[] = [], focused: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  state.subscribe((update) => focused.push(update));
  gap(state, [snap("a", 2)]);
  assert.equal(state.snapshots.has("b"), false);
  assert.equal(state.focusedSessionId, "a");
  assert.deepEqual(all.map((update) => update.snapshot.info.sessionId), ["a"]);
  assert.deepEqual(focused.map((update) => update.snapshot.info.sessionId), ["a"]);
});

test("sessions newer than an older gap remain cached without invented gap notifications", () => {
  const state = fixture("c");
  state.applySnapshot(snap("c", 9), 9);
  state.focusedSessionId = "c";
  state.refreshFocusedSessionSnapshot();
  const all: Update[] = [];
  state.subscribeAllRuntimeEvents((update) => all.push(update));
  gap(state);
  assert.equal(state.snapshots.get("c")?.revision, 9);
  assert.deepEqual(all.map((update) => update.snapshot.info.sessionId), ["a", "b"]);
  assert.equal(state.focusedSessionId, "c");
});

test("late subscription preserves retained event payload before snapshot-only gap refresh", () => {
  const state = fixture();
  state.handle({ kind: "event", hostEpoch: "epoch-a", sequence: 2,
    update: { snapshot: snap("b", 2), event: { type: "retained.notice" } } });
  gap(state, [snap("a", 3), snap("b", 3)], 5);
  const focused: Update[] = [];
  state.subscribe((update) => focused.push(update));
  assert.deepEqual(focused.map((update) => update.event?.type), ["retained.notice", undefined]);
  assert.deepEqual(focused.map((update) => update.snapshot.revision), [3, 3]);
});
