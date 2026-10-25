import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only reviewed source fragments run. No production Host, SDK, transport,
// OAuth provider, filesystem operation or network capability is imported.
const file = process.env.BINY_MCP_LIST_SOURCE ?? path.join(process.cwd(), "src/extensions/mcp.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
const host = one(source.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "McpToolHost"), "host declaration");
const methods = ["listServerResources", "listServerPrompts"].map(name => one(host.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name), name));
const helper = one(source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "errorText"), "error helper");
const budget = one(source.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
  .filter(node => ts.isIdentifier(node.name) && node.name.text === "maxResourceListPages"), "page budget");
assert.equal(budget.initializer?.getText(source), "4", "preserve the defensive four-page cap");
const calls = new Set([
  "signal?.throwIfAborted", "this.requireServer", "this.servers.values", "[...this.servers.values()].filter",
  "waitForMcpReconnect", "this.reconnect", "this.requestWithCredentials", "client.listResources",
  "client.listPrompts", "client?.getServerCapabilities", "resources.push", "prompts.push", "result.prompts.slice",
  "seen.has", "seen.add", "errorText", "String", "Promise.all", "targets.map"
]);
function guard(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isTaggedTemplateExpression(node));
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)), `unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.ok(["Set", "Error"].includes(node.expression.getText(source)), "only inert objects");
  ts.forEachChild(node, guard);
}
for (const node of [...methods, helper, budget]) guard(node);
const compiled = ts.transpileModule(`const ${budget.getText(source)};\n${helper.getText(source)}\nclass ListingProjection {\n${methods.map(node => node.getText(source)).join("\n")}\n}\nListingProjection.prototype;`,
  { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
type Kind = "resources" | "prompts";
type Row = { name: string; uri?: string };
type Page = { resources: Row[]; prompts: Row[]; nextCursor?: string };
type ResultRow = { server: string; name?: string; uri?: string; prompts?: Row[]; error?: string };
type Signal = { throwIfAborted(): void };
type Managed = { name: string; status: { connected: boolean; enabled: boolean; hasResources: boolean }; client: {
  getServerCapabilities(): { prompts: object };
  listResources(params?: { cursor?: string }): Promise<Page>;
  listPrompts(params?: { cursor?: string }): Promise<Page>;
} };
interface InertHost {
  servers: Map<string, Managed>;
  requireServer(name: string): Managed;
  reconnect(): Promise<void>;
  requestWithCredentials(managed: Managed, request: (options: object) => Promise<Page>, signal?: Signal): Promise<Page>;
}
type Listing = (this: InertHost, name?: string, signal?: Signal) => Promise<ResultRow[]>;
const project = runInNewContext(compiled.outputText, {
  Error,
  waitForMcpReconnect: () => { throw new Error("fixture must never reconnect"); }
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as {
  listServerResources: Listing; listServerPrompts: Listing;
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function page(names: string[], nextCursor?: string): Page {
  return { resources: names.map(name => ({ name, uri: `fixture://${name}` })), prompts: names.map(name => ({ name })), nextCursor };
}
function fixture(kind: Kind, plans: Record<string, Array<Page | Error>>, afterPage?: () => void) {
  const requests: Array<{ server: string; cursor?: string }> = [];
  const servers = new Map<string, Managed>();
  for (const [name, pages] of Object.entries(plans)) {
    let index = 0;
    const list = async (params?: { cursor?: string }): Promise<Page> => {
      requests.push({ server: name, cursor: params?.cursor });
      const value = pages[index++];
      assert.ok(value, "unexpected extra page request");
      if (value instanceof Error) throw value;
      afterPage?.();
      return structuredClone(value);
    };
    servers.set(name, { name, status: { connected: true, enabled: true, hasResources: true }, client: {
      getServerCapabilities: () => ({ prompts: {} }), listResources: list, listPrompts: list
    } });
  }
  const inert: InertHost = {
    servers,
    requireServer: name => { const managed = servers.get(name); assert.ok(managed); return managed; },
    reconnect: async () => { throw new Error("unexpected reconnect"); },
    requestWithCredentials: async (_managed, request, signal) => { signal?.throwIfAborted(); return await request({}); }
  };
  const method = kind === "resources" ? project.listServerResources : project.listServerPrompts;
  return { requests, run: async (name?: string, signal?: Signal) => plain(await method.call(inert, name, signal)) };
}
function names(kind: Kind, result: ResultRow[], server = "fixture"): string[] {
  return result.filter(row => row.server === server).flatMap(row => kind === "resources" ? row.name ? [row.name] : [] : (row.prompts ?? []).map(prompt => prompt.name));
}
function incomplete(result: ResultRow[], server = "fixture") {
  const errors = result.filter(row => row.server === server && row.error);
  assert.equal(errors.length, 1, "incomplete listing must carry one existing per-server error signal");
  assert.match(errors[0]!.error!, /incomplete/i);
  assert.equal(JSON.stringify(result).includes("private-cursor"), false, "private continuations must not enter output");
}
for (const kind of ["resources", "prompts"] as const) {
  test(`${kind}: complete two-page response clears the prior request cursor`, async () => {
    const f = fixture(kind, { fixture: [page(["one"], "private-cursor-two"), page(["two"])] });
    const result = await f.run("fixture");
    assert.deepEqual(names(kind, result), ["one", "two"]);
    assert.ok(result.every(row => row.error === undefined));
    assert.deepEqual(f.requests.map(request => request.cursor), [undefined, "private-cursor-two"]);
  });
  test(`${kind}: capped prefix retains rows and reports incomplete listing`, async () => {
    const f = fixture(kind, { fixture: Array.from({ length: 5 }, (_, index) => page([String(index)], `private-cursor-${index}`)) });
    const result = await f.run("fixture");
    assert.equal(f.requests.length, 4);
    assert.deepEqual(names(kind, result), ["0", "1", "2", "3"]);
    assert.deepEqual(f.requests.map(request => request.cursor), [undefined, "private-cursor-0", "private-cursor-1", "private-cursor-2"]);
    incomplete(result);
  });
  test(`${kind}: exactly four complete pages and empty results remain normal`, async () => {
    const f = fixture(kind, { fixture: Array.from({ length: 4 }, (_, index) => page([String(index)], index < 3 ? `private-cursor-${index}` : undefined)) });
    const result = await f.run("fixture");
    assert.deepEqual(names(kind, result), ["0", "1", "2", "3"]);
    assert.ok(result.every(row => row.error === undefined));
    assert.equal(f.requests.length, 4);
    const empty = fixture(kind, { fixture: [page([])] });
    const value = await empty.run();
    assert.deepEqual(names(kind, value), []);
    assert.ok(value.every(row => row.error === undefined));
    assert.equal(empty.requests.length, 1);
  });
  test(`${kind}: ordinary errors and pre-cancellation preserve existing behavior`, async () => {
    const f = fixture(kind, { fixture: [new Error("ordinary fixture failure")] });
    assert.deepEqual(await f.run("fixture"), [{ server: "fixture", error: "ordinary fixture failure" }]);
    const cancelled = fixture(kind, { fixture: [page(["unused"])] });
    const reason = new Error("cancelled");
    await assert.rejects(cancelled.run("fixture", { throwIfAborted: () => { throw reason; } }), error => error === reason);
    assert.equal(cancelled.requests.length, 0);
  });
  test(`${kind}: cancellation between pages prevents continuation`, async () => {
    let aborted = false;
    const reason = new Error("cancelled after page");
    const f = fixture(kind, { fixture: [page(["one"], "private-cursor-next"), page(["two"])] }, () => { aborted = true; });
    await assert.rejects(f.run("fixture", { throwIfAborted: () => { if (aborted) throw reason; } }), error => error === reason);
    assert.equal(f.requests.length, 1);
  });
  test(`${kind}: two independent servers retain their own cursors and completeness`, async () => {
    const f = fixture(kind, {
      fixture: Array.from({ length: 5 }, (_, index) => page([`a${index}`], `private-cursor-a${index}`)),
      other: [page(["b0"], "private-cursor-b"), page(["b1"])]
    });
    const result = await f.run();
    assert.deepEqual(names(kind, result), ["a0", "a1", "a2", "a3"]);
    assert.deepEqual(names(kind, result, "other"), ["b0", "b1"]);
    assert.ok(result.filter(row => row.server === "other").every(row => row.error === undefined));
    assert.deepEqual(f.requests.filter(request => request.server === "other").map(request => request.cursor), [undefined, "private-cursor-b"]);
    incomplete(result);
  });
}
for (const count of [128, 129]) {
  test(`prompts: same-page ${count} entries preserve the 128-item budget`, async () => {
    const expected = Array.from({ length: 128 }, (_, index) => String(index));
    const f = fixture("prompts", { fixture: [page(Array.from({ length: count }, (_, index) => String(index)))] });
    const result = await f.run("fixture");
    assert.deepEqual(names("prompts", result), expected);
    assert.equal(f.requests.length, 1);
    if (count > 128) incomplete(result); else assert.ok(result.every(row => row.error === undefined));
  });
}
test("prompts: item budget with a remaining cursor reports incomplete", async () => {
  const rows = Array.from({ length: 128 }, (_, index) => String(index));
  const f = fixture("prompts", { fixture: [page(rows, "private-cursor-more")] });
  const result = await f.run("fixture");
  assert.deepEqual(names("prompts", result), rows);
  assert.equal(f.requests.length, 1);
  incomplete(result);
});
test("prompts: repeated cursor stops without silently claiming completion", async () => {
  const f = fixture("prompts", { fixture: [page(["one"], "private-cursor-cycle"), page(["two"], "private-cursor-cycle")] });
  const result = await f.run("fixture");
  assert.deepEqual(names("prompts", result), ["one", "two"]);
  assert.equal(f.requests.length, 2);
  incomplete(result);
});
