import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { DesktopAgentEventEnvelope, DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { applyUpdatesToWorkspace } from "../src/desktop/renderer/src/app/desktopState.js";

function snapshot(id: string, revision = 1, maintenance = false): InteractiveRuntimeSnapshot {
  return { revision, permissionMode: "ask", state: maintenance ? { kind: "maintenance", operation: "resume" } : { kind: "idle" },
    info: { workspaceRoot: "/synthetic", sessionId: id, sessionFile: "/synthetic/session", provider: "test", modelLabel: "test", reasoningLabel: "", modelAlias: "test", thinking: "off" } };
}
function workspace(runtimes?: DesktopWorkspaceSnapshot["sessionRuntimes"]): DesktopWorkspaceSnapshot {
  return { project: { id: "project", path: "/synthetic", name: "Synthetic", dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" },
    sessions: [], sessionRuntimes: runtimes, permissionMode: "ask", capabilityDefaults: { tools: "auto", skills: "auto" },
    requiresModelConfiguration: false, pickerModels: [], models: [], connections: [] };
}
function envelope(value: InteractiveRuntimeSnapshot, primary = false): DesktopAgentEventEnvelope {
  return { projectId: "project", sessionId: value.info.sessionId, primary, snapshot: value };
}

test("runtime batch copies the session dictionary only once", () => {
  const source = readFileSync(new URL("../src/desktop/renderer/src/app/desktopState.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("desktopState.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "applyUpdatesToWorkspace");
  assert.ok(declaration);
  // Instrument only native object-spread operands to count dictionary entries copied.
  // The public function is also executed below; no timing or compiler helper is asserted.
  let spreads = 0;
  const instrumented = declaration.getText(ast).replace(/\.\.\.sessionRuntimes\b/gu, () => { spreads++; return "...countCopy(sessionRuntimes)"; });
  assert.ok(spreads > 0);
  const js = ts.transpileModule(instrumented.replace(/^export /u, "") + "\nglobalThis.project = applyUpdatesToWorkspace;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  let copied = 0;
  const sandbox = { project: undefined as typeof applyUpdatesToWorkspace | undefined,
    countCopy(value: DesktopWorkspaceSnapshot["sessionRuntimes"]) { copied += Object.keys(value ?? {}).length; return value; },
    // These are snapshot-only envelopes; the real session reducer is verified unchanged below.
    applyUpdatesToProjectSessions(_id: string, sessions: DesktopWorkspaceSnapshot["sessions"]) { return sessions; }
  };
  runInNewContext(js, sandbox, { timeout: 1000 });
  const initial = Object.freeze(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`session-${i}`, snapshot(`session-${i}`)])));
  const input = workspace(initial);
  const updates = Array.from({ length: 100 }, (_, i) => envelope(snapshot(`session-${i}`, i + 2)));
  const measured = sandbox.project!(input, updates);
  const actual = applyUpdatesToWorkspace(input, updates);
  assert.equal(JSON.stringify(measured), JSON.stringify(actual));
  assert.equal(copied, 1000, `copied ${copied} runtime entries for one batch`);
  assert.notEqual(actual.sessionRuntimes, initial);
  assert.equal(initial["session-0"]?.revision, 1);
  assert.equal(actual.sessionRuntimes?.["session-99"]?.revision, 101);
});

test("empty and foreign batches retain the original runtime dictionary", () => {
  const input = workspace(Object.freeze({ old: snapshot("old") }));
  assert.equal(applyUpdatesToWorkspace(input, []).sessionRuntimes, input.sessionRuntimes);

  assert.equal(applyUpdatesToWorkspace(input, [{ ...envelope(snapshot("other")), projectId: "elsewhere" }]).sessionRuntimes, input.sessionRuntimes);
});

test("primary rebinding clears only the matching maintenance owner in batch order", () => {
  const old = snapshot("old", 1, true), replacement = snapshot("new", 2);
  const input = { ...workspace(Object.freeze({ old })), runtime: old };
  const result = applyUpdatesToWorkspace(input, [envelope(old, true), envelope(replacement, true)]);
  assert.equal(result.runtime, replacement);
  assert.equal(Object.hasOwn(result.sessionRuntimes!, "old"), false);
  assert.equal(result.sessionRuntimes?.new, replacement);
  assert.equal(input.sessionRuntimes?.old, old);
  const parallel = snapshot("old", 3);
  const preserved = applyUpdatesToWorkspace(input, [envelope(parallel), envelope(replacement, true)]);
  assert.equal(preserved.sessionRuntimes?.old, parallel);
  assert.equal(preserved.sessionRuntimes?.new, replacement);
});

test("runtime ids remain own data properties, including prototype-like keys", () => {
  const updates = ["__proto__", "constructor", "toString", "normal"].map(id => envelope(snapshot(id)));
  const result = applyUpdatesToWorkspace(workspace(), updates);
  assert.equal(Object.getPrototypeOf(result.sessionRuntimes), Object.prototype);
  for (const update of updates) {
    assert.equal(Object.hasOwn(result.sessionRuntimes!, update.sessionId!), true);
    assert.equal(result.sessionRuntimes?.[update.sessionId!], update.snapshot);
  }
  assert.equal(applyUpdatesToWorkspace(workspace(), [envelope(snapshot(""))]).sessionRuntimes, undefined);
});

test("primary rebinding can remove maintenance without adding an empty session id", () => {
  const old = snapshot("old", 1, true);
  const input = { ...workspace(Object.freeze({ old })), runtime: old };
  const idle = snapshot("", 2);
  const result = applyUpdatesToWorkspace(input, [envelope(idle, true)]);
  assert.equal(result.runtime, idle);
  assert.deepEqual(result.sessionRuntimes, {});
  assert.equal(input.sessionRuntimes?.old, old);
});
