/** Actual service class with inert ports: no project disk reads, PTYs, servers or network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("DesktopPreviewService.ts", readFileSync(
  path.resolve("src/desktop/electron/main/DesktopPreviewService.ts"), "utf8"
), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "DesktopPreviewService");
assert.ok(declaration);
const allowedCalls = new Set([
  "this.enqueue", "this.startNow", "this.stopNow", "this.projects.requireProject",
  "this.projects.projectPreviewAvailability", "this.staticPreview.status", "this.staticPreview.start", "this.staticPreview.stop",
  "availability.entries.includes", "this.terminals.clearPreviewFailure", "this.terminals.startPreview", "this.terminals.previewStatus",
  "this.terminals.list", "this.terminals.list(projectId).find", "this.terminals.dispose",
  "this.operations.get", "this.operations.set", "this.operations.delete", "Promise.resolve",
  "(this.operations.get(projectId) ?? Promise.resolve()).then", "result.then", "tail.then"
]);
const allowedConstructors = new Set(["Map", "Error"]);
function verifyBoundary(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(allowedConstructors.has(node.expression.getText(source)), `Unreviewed constructor: ${node.expression.getText(source)}`);
  ts.forEachChild(node, verifyBoundary);
}
verifyBoundary(declaration);
const emitted = ts.transpileModule(`${declaration.getText(source).replace(/^export\s+/u, "")}\nglobalThis.Service = DesktopPreviewService;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(/u.test(emitted.outputText), false);
type Availability = { available: true; command: string } | { available: true; kind: "static"; entry: string; entries: string[] };
type Status = { kind: string; terminalId?: string; url?: string };
interface Service {
  start(id: string, entry?: string): Promise<Status>;
  stop(id: string): Promise<{ stopped: true }>;
  status(id: string): Status;
  operations?: Map<string, Promise<void>>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function fixture(kind: "script" | "static" = "script") {
  const events: string[] = [];
  const sessions = new Map<string, string>();
  const servers = new Map<string, { url: string }>();
  const pendingServers = new Map<string, Promise<{ url: string }>>();
  let serial = 0;
  const answer: Availability = kind === "script" ? { available: true, command: "npm run dev" }
    : { available: true, kind: "static", entry: "index.html", entries: ["index.html"] };
  const gates = {
    availability: undefined as Promise<Availability> | undefined,
    terminal: undefined as Promise<void> | undefined,
    listen: undefined as Promise<void> | undefined,
    close: undefined as Promise<void> | undefined
  };
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1_000 });
  const ServiceClass = context.Service as new (projects: unknown, terminals: unknown, staticPreview: unknown) => Service;
  const service = new ServiceClass({
    requireProject: (id: string) => ({ id, path: `/inert/${id}` }),
    projectPreviewAvailability: async (id: string) => {
      events.push(`detect:${id}`);
      return await (gates.availability ?? Promise.resolve(answer));
    }
  }, {
    startPreview: async (id: string) => {
      events.push(`terminal-enter:${id}`);
      await gates.terminal;
      let terminalId = sessions.get(id);
      if (!terminalId) { terminalId = `fake-${++serial}`; sessions.set(id, terminalId); events.push(`create:${id}:${terminalId}`); }
      return { terminalId, replay: "", sequence: 0 };
    },
    list: (id: string) => sessions.has(id) ? [{ terminalId: sessions.get(id), slotId: "preview" }] : [],
    dispose: (terminalId: string) => {
      events.push(`dispose:${terminalId}`);
      for (const [id, current] of sessions) if (current === terminalId) sessions.delete(id);
    },
    clearPreviewFailure() {},
    previewStatus: (id: string) => sessions.has(id) ? { kind: "starting", terminalId: sessions.get(id) } : { kind: "stopped" }
  }, {
    status: (id: string) => servers.get(id),
    start: async (id: string) => {
      const existing = servers.get(id);
      if (existing) return existing;
      const pending = pendingServers.get(id);
      if (pending) return await pending;
      const operation = (async () => {
        events.push(`listen-enter:${id}`);
        await gates.listen;
        const server = { url: `http://inert.invalid/${id}/${++serial}` };
        servers.set(id, server); events.push(`static-create:${id}`);
        return server;
      })();
      pendingServers.set(id, operation);
      try { return await operation; }
      finally { if (pendingServers.get(id) === operation) pendingServers.delete(id); }
    },
    stop: async (id: string) => {
      events.push(`close-enter:${id}`);
      // Match StaticPreviewServer: wait only for a listen already registered for this id.
      const pending = pendingServers.get(id);
      if (pending) await pending.catch(() => undefined);
      await gates.close;
      servers.delete(id); events.push(`close-done:${id}`);
    }
  });
  return { service, gates, events, sessions, servers, answer };
}

for (const kind of ["script", "static"] as const) {
  test(`stop waits for an accepted ${kind} start still detecting availability, then closes it`, async () => {
    const f = fixture(kind), gate = deferred<Availability>(); f.gates.availability = gate.promise;
    const start = f.service.start("p"); await settle();
    let stopped = false;
    const stop = f.service.stop("p").then(value => { stopped = true; return value; });
    await settle(); assert.equal(stopped, false); assert.equal(f.events.includes("close-enter:p"), false);
    gate.resolve(f.answer); await start; assert.equal((await stop).stopped, true);
    assert.equal(f.service.status("p").kind, "stopped"); assert.equal(f.sessions.size + f.servers.size, 0);
    await settle(); if (f.service.operations) assert.equal(f.service.operations.size, 0);
  });
}

test("stop waits for a pending static listen and closes the resulting server", async () => {
  const f = fixture("static"), listening = deferred<void>(); f.gates.listen = listening.promise;
  const start = f.service.start("p"); await settle(); assert.ok(f.events.includes("listen-enter:p"));
  let stopped = false;
  const stop = f.service.stop("p").then(value => { stopped = true; return value; });
  await settle(); assert.equal(stopped, false);
  listening.resolve(); await start; await stop;
  assert.equal(f.servers.size, 0); assert.equal(f.service.status("p").kind, "stopped");
  assert.ok(f.events.indexOf("static-create:p") < f.events.indexOf("close-done:p"));
});

test("stop waits for pending terminal creation; a newer start cannot share or lose the old resource", async () => {
  const f = fixture(), creation = deferred<void>(), closing = deferred<void>();
  f.gates.terminal = creation.promise; f.gates.close = closing.promise;
  const first = f.service.start("p"); await settle(); assert.ok(f.events.includes("terminal-enter:p"));
  const stop = f.service.stop("p"), next = f.service.start("p");
  await settle(); assert.equal(f.events.includes("close-enter:p"), false);
  creation.resolve(); const old = await first; await settle();
  assert.ok(f.events.includes(`dispose:${old.terminalId}`)); assert.ok(f.events.includes("close-enter:p"));
  assert.equal(f.events.filter(event => event === "terminal-enter:p").length, 1);
  closing.resolve(); await stop; const fresh = await next;
  assert.notEqual(fresh.terminalId, old.terminalId); assert.equal(f.sessions.get("p"), fresh.terminalId);
  assert.equal(f.events.includes(`dispose:${fresh.terminalId}`), false);
  assert.ok(f.events.indexOf("close-done:p") < f.events.indexOf(`create:p:${fresh.terminalId}`));
});

test("a rejected start does not poison stop or a newer start", async () => {
  const f = fixture(), gate = deferred<Availability>(); f.gates.availability = gate.promise;
  const start = f.service.start("p"), failed = assert.rejects(start, /detection failed/u);
  const stop = f.service.stop("p"); await settle();
  gate.reject(new Error("detection failed")); await failed; await stop;
  f.gates.availability = undefined;
  assert.equal((await f.service.start("p")).kind, "script");
  await settle(); if (f.service.operations) assert.equal(f.service.operations.size, 0);
});

test("a rejected stop does not poison a subsequent request", async () => {
  const f = fixture(), gate = deferred<void>(); await f.service.start("p"); f.gates.close = gate.promise;
  const stop = f.service.stop("p"), failed = assert.rejects(stop, /close failed/u);
  const next = f.service.start("p"); await settle();
  gate.reject(new Error("close failed")); await failed;
  assert.equal((await next).kind, "script");
});

for (const kind of ["script", "static"] as const) {
  test(`consecutive ${kind} starts retain existing resource reuse`, async () => {
    const f = fixture(kind); const [first, second] = await Promise.all([f.service.start("p"), f.service.start("p")]);
    assert.equal(kind === "script" ? first.terminalId : first.url, kind === "script" ? second.terminalId : second.url);
    assert.equal(f.events.filter(event => event.startsWith(kind === "script" ? "create:" : "static-create:")).length, 1);
  });
}

test("a blocked project does not serialize another project, and status stays synchronous", async () => {
  const f = fixture(), gate = deferred<Availability>(); f.gates.availability = gate.promise;
  const blocked = f.service.start("p"); await settle(); f.gates.availability = undefined;
  const independent = await f.service.start("q"); assert.equal(independent.kind, "script");
  const status = f.service.status("q"); assert.equal(status.kind, "starting"); assert.equal("then" in status, false);
  gate.resolve(f.answer); await blocked;
});
