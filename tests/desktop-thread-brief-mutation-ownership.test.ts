import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

// Execute the actual service with inert persistence, filesystem visibility,
// project creation and native-dialog boundaries. No Electron, SQLite or model.
const source = readFileSync(new URL("../src/desktop/electron/main/DesktopThreadBriefService.ts", import.meta.url), "utf8");
function deferred() {
  let resolve!: (value?: any) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const original = (id: string) => ({ id, signature: id, kind: "create", status: "open", name: "Project", brief: "Brief", focus: "",
  threads: [{ sessionId: "s", projectId: "source", title: "Thread", createdAt: "2026-01-01" }] });
const actions = ["accept", "revise", "dismiss", "rewrite", "choose-location"] as const;
type Action = typeof actions[number];
function request(action: Action, id = "a") {
  return { action, id, ...(action === "revise" ? { name: "Edited", brief: "Edited brief", focus: "", sessionIds: ["s"] } : {}),
    ...(action === "rewrite" ? { feedback: "Clarify" } : {}) };
}
function fixture() {
  const suggestions = new Map<string, any>(["a", "b"].map(id => [id, original(id)]));
  const created: string[] = [], accepted: string[] = [], dialogs: string[] = [], writes: string[] = [];
  let visibilityGate: ReturnType<typeof deferred> | undefined;
  let visibilityError = false, createError = false, acceptError = false, rewriteError = false;
  let dialog: (id: string) => Promise<string | undefined> = async id => `/created/${id}`;
  const store = {
    suggestion: (id: string) => structuredClone(suggestions.get(id)),
    putSuggestion: (value: any) => { writes.push(value.id); suggestions.set(value.id, structuredClone(value)); },
    accept: (id: string, projectId: string) => {
      if (acceptError) throw Error("accept failed");
      const current = suggestions.get(id);
      if (current?.status !== "open") throw Error("not open");
      accepted.push(projectId); suggestions.set(id, { ...current, projectId, status: "accepted" });
    },
    snapshot: () => ({ briefs: [], projects: [], suggestions: [...suggestions.values()].filter(value => value.status === "open").map(value => structuredClone(value)) })
  };
  const output: Record<string, any> = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.deepEqual(compiled.diagnostics, []);
  vm.runInNewContext(compiled.outputText, { exports: output, structuredClone, require(id: string) {
    if (id === "zod") return { z };
    if (id.endsWith("/threadBriefStore.js")) return { threadBriefSettingsSchema: z.object({}).strict() };
    if (id.endsWith("/threadBriefService.js")) return { ThreadBriefService: class {
      store = store;
      async rewriteSuggestion(id: string): Promise<void> {
        if (rewriteError) throw Error("rewrite failed");
        store.putSuggestion({ ...store.suggestion(id), name: "Rewritten" });
      }
    } };
    if (id.endsWith("/store.js")) return { resolveSessionFile: async () => "/inert/s.jsonl", sessionIdFromFile: () => "s" };
    // Unused imported helpers cannot silently execute native operations.
    return new Proxy({}, { get: (_target, name) => { throw Error(`Unexpected dependency: ${id}.${String(name)}`); } });
  } });
  const service = new output.DesktopThreadBriefService({ store, state: { projects: () => [{ id: "source", path: "/inert" }] },
    projects: {
      async dataRoot() {
        const gate = visibilityGate; visibilityGate = undefined;
        if (gate) await gate.promise;
        if (visibilityError) throw Error("visibility failed");
        return "/inert";
      },
      async createEmptyProject(directory: string) { if (createError) throw Error("create failed"); created.push(directory); return { id: directory }; },
      requireProject() {}
    },
    async chooseProjectDirectory(suggestion: any) { dialogs.push(suggestion.id); return await dialog(suggestion.id); }
  });
  return { service, suggestions, created, accepted, dialogs, writes,
    holdVisibility() { visibilityGate = deferred(); return visibilityGate; },
    setDialog(value: typeof dialog) { dialog = value; },
    fail(kind: "visibility" | "create" | "accept" | "rewrite", value = true) {
      if (kind === "visibility") visibilityError = value;
      if (kind === "create") createError = value;
      if (kind === "accept") acceptError = value;
      if (kind === "rewrite") rewriteError = value;
    }
  };
}

for (const owner of actions) for (const contender of actions) {
  test(`${owner} excludes ${contender} before visibility yields`, async () => {
    const f = fixture(), gate = f.holdVisibility();
    const first = f.service.request(request(owner));
    try {
      await assert.rejects(f.service.request(request(contender)), /正在.*项目建议/);
      // A rejected contender must not release the original owner's lease.
      await assert.rejects(f.service.request(request("accept")), /正在.*项目建议/);
      assert.equal(f.created.length, 0); assert.equal(f.writes.length, 0);
    } finally { gate.resolve(); await first; }
    assert.equal(f.created.length, owner === "accept" ? 1 : 0);
    assert.equal(f.suggestions.get("a").status, owner === "accept" ? "accepted" : owner === "dismiss" ? "dismissed" : "open");
  });
}

test("different suggestions and overview remain concurrent", async () => {
  const f = fixture(), gate = f.holdVisibility();
  const first = f.service.request(request("accept"));
  try {
    await f.service.request(request("accept", "b"));
    await f.service.request({ action: "overview" });
    assert.deepEqual(f.accepted, ["/created/b"]);
  } finally { gate.resolve(); await first; }
  assert.deepEqual(f.accepted, ["/created/b", "/created/a"]);
});

test("native chooser holds ownership and cancellation permits retry", async () => {
  const f = fixture(), gate = deferred(); f.setDialog(async () => await gate.promise);
  const first = f.service.request(request("accept")); await flush();
  try { await assert.rejects(f.service.request(request("accept")), /正在.*项目建议/); assert.deepEqual(f.dialogs, ["a"]); }
  finally { gate.resolve(undefined); await first; }
  assert.equal(f.created.length, 0); assert.equal(f.suggestions.get("a").status, "open");
  f.setDialog(async () => "/retry"); await f.service.request(request("accept"));
  assert.deepEqual(f.created, ["/retry"]);
});

for (const action of ["accept", "choose-location"] as const) {
  test(`${action}: chooser error releases ownership`, async () => {
    const f = fixture(); f.setDialog(async () => { throw Error("chooser failed"); });
    await assert.rejects(f.service.request(request(action)), /chooser failed/);
    f.setDialog(async () => "/retry"); await f.service.request(request(action));
    assert.equal(action === "accept" ? f.suggestions.get("a").projectId : f.suggestions.get("a").location, "/retry");
  });
}

for (const kind of ["visibility", "create", "rewrite"] as const) {
  test(`${kind} failure releases ownership for retry`, async () => {
    const f = fixture(); f.fail(kind);
    const action = kind === "rewrite" ? "rewrite" : "accept";
    await assert.rejects(f.service.request(request(action)), new RegExp(`${kind} failed`));
    f.fail(kind, false); await f.service.request(request(action));
    assert.equal(f.suggestions.get("a").status, action === "accept" ? "accepted" : "open");
  });
}

test("association failure keeps created project for retry; repeated accept cannot recreate", async () => {
  const f = fixture(); f.fail("accept");
  await assert.rejects(f.service.request(request("accept")), /accept failed/);
  assert.equal(f.suggestions.get("a").projectId, "/created/a");
  assert.equal(f.suggestions.get("a").status, "open");
  f.fail("accept", false); await f.service.request(request("accept"));
  await assert.rejects(f.service.request(request("accept")), /已处理/);
  assert.deepEqual(f.created, ["/created/a"]); assert.deepEqual(f.dialogs, ["a"]); assert.deepEqual(f.accepted, ["/created/a"]);
});

test("dismissed suggestion remains closed and lock is released", async () => {
  const f = fixture(); await f.service.request(request("dismiss"));
  await assert.rejects(f.service.request(request("revise")), /已处理/);
  await assert.rejects(f.service.request(request("accept")), /已处理/);
  assert.equal(f.suggestions.get("a").status, "dismissed"); assert.equal(f.created.length, 0);
});

test("location chooser cancellation leaves the suggestion unchanged and permits retry", async () => {
  const f = fixture(); f.setDialog(async () => undefined);
  await f.service.request(request("choose-location"));
  assert.deepEqual(f.suggestions.get("a"), original("a"));
  f.setDialog(async () => "/chosen"); await f.service.request(request("choose-location"));
  assert.equal(f.suggestions.get("a").location, "/chosen"); assert.equal(f.created.length, 0);
});
