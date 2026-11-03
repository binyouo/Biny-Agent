import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Source-selected production fetch/parser and cache-publication orchestration only.
// No product module import, provider, network, database, timers or filesystem writes.
const catalog = ts.createSourceFile("catalog.ts", readFileSync(new URL("../src/ai/modelCatalog.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const runtime = ts.createSourceFile("runtime.ts", readFileSync(new URL("../src/llm/ProviderRuntime.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declarations = catalog.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
  || ts.isVariableStatement(node) && node.declarationList.declarations.every(item => ts.isIdentifier(item.name) && ["catalogTimeoutMs", "maxModelCatalogPages"].includes(item.name.text)));
const provider = runtime.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ConfiguredProviderRuntime")!;
const refresh = provider.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "refreshModels")!;
assert.ok(refresh);
const code = ts.transpileModule(declarations.map(node => node.getText(catalog).replace(/^export /u, "")).join("\n")
  + `\nclass Publication { ${refresh.getText(runtime)} }\nthis.snapshot = fetchModelCatalogSnapshot; this.refresh = Publication.prototype.refreshModels;`,
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Entry = { id: string };
type Snapshot = { models?: Entry[]; notModified: boolean; etag?: string; lastModified?: number };
type Request = { url: URL; headers: Headers; signal?: AbortSignal | null };
function fixture(reply: (request: Request, index: number) => Response | Promise<Response>, protocol = "anthropic", endpoint = "https://catalog.fixture.invalid/v1/models?limit=1&tenant=a%2Fb") {
  const timeout = new AbortController();
  const calls: Request[] = [];
  const sandbox = {
    URL, Buffer, TextDecoder, process: { env: {} },
    AbortSignal: { any: AbortSignal.any, timeout: (ms: number) => { assert.equal(ms, 15_000); return timeout.signal; } },
    providerProtocol: () => protocol, resolveProviderRequestRoute: () => ({ apiBackend: "anthropic_messages" }),
    inferReasoningEfforts: () => [], createRetryFetch: (_policy: unknown, fetcher: unknown) => fetcher,
    modelCatalogCacheKey: () => "fixture-key", readProviderCatalog: async () => ({ sourceKey: "fixture-key", models: [{ id: "old" }], etag: '"old"' })
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(code, sandbox);
  const loaded = sandbox as typeof sandbox & {
    snapshot(request: unknown, signal: AbortSignal | undefined, validators: unknown, fetcher: unknown): Promise<Snapshot>;
    refresh(this: unknown, signal?: AbortSignal): Promise<Entry[]>;
  };
  const config = { type: protocol === "anthropic" ? "anthropic" : "openai-compatible", apiKey: "fixture-key-secret", modelsEndpoint: endpoint };
  const definition = { authModes: ["api-key"], requiresApiKey: true };
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const request = { url: new URL(String(input)), headers: new Headers(init?.headers), signal: init?.signal };
    calls.push(request);
    return await reply(request, calls.length);
  };
  const writes: unknown[] = [];
  const restored: Entry[][] = [];
  const receiver = { id: "fixture", config, definition, modelsStore: { write: async (_key: string, value: unknown) => { writes.push(value); } }, fetcher,
    restoreModels: (entries: Entry[]) => { restored.push(entries); }, normalizeCatalogEntry: (entry: Entry) => entry,
    get liveModels() { return restored.at(-1) ?? [{ id: "old" }]; }, getModels: () => restored.at(-1) ?? [{ id: "old" }] };
  return { calls, timeout, writes, restored,
    run: (signal?: AbortSignal) => loaded.snapshot({ alias: "fixture", config, definition }, signal, { etag: '"old"', lastModified: 1_000 }, fetcher),
    publish: (signal?: AbortSignal) => loaded.refresh.call(receiver, signal) };
}
const page = (id: string, more = false, cursor: unknown = id, headers?: HeadersInit) => Response.json({ data: [{ id }], has_more: more, last_id: cursor }, { headers });
const ids = (value: Snapshot) => Array.from(value.models ?? [], entry => entry.id);

test("Anthropic follows encoded cursors and preserves endpoint parameters and authentication", async () => {
  const cursor = "model/+?&=秘密";
  const f = fixture((request, index) => {
    assert.equal(request.url.origin, "https://catalog.fixture.invalid");
    assert.equal(request.url.pathname, "/v1/models");
    assert.equal(request.url.searchParams.get("tenant"), "a/b");
    assert.equal(request.url.searchParams.get("limit"), "1");
    assert.equal(request.headers.get("x-api-key"), "fixture-key-secret");
    assert.equal(request.url.href.includes("fixture-key-secret"), false);
    if (index === 2) assert.equal(request.url.searchParams.get("after_id"), cursor);
    return page(index === 1 ? "first" : "second", index === 1, cursor);
  });
  assert.deepEqual(ids(await f.run()), ["first", "second"]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.signal, f.calls[1]!.signal);
});

for (const cursor of [undefined, null, "", 123]) test(`missing or invalid continuation ${String(cursor)} rejects without publication`, async () => {
  const f = fixture(() => Response.json({ data: [{ id: "first" }], has_more: true, last_id: cursor }));
  await assert.rejects(f.publish(), /cursor|continuation|pagination/i);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("an overlong continuation is rejected before another request", async () => {
  const f = fixture(() => page("first", true, "x".repeat(1_025)));
  await assert.rejects(f.run(), /cursor/); assert.equal(f.calls.length, 1);
});
test("a repeated cursor rejects instead of looping or caching a prefix", async () => {
  const f = fixture(() => page("first", true, "same"));
  await assert.rejects(f.publish(), /cursor|continuation|pagination/i);
  assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 0);
});
test("cursor cycles are bounded without disclosing private continuation text", async () => {
  const f = fixture((_request, index) => page(String(index), true, index % 2 ? "private-A" : "private-B"));
  await assert.rejects(f.publish(), (error: unknown) => /repeated cursor/.test(String(error)) && !String(error).includes("private-"));
  assert.equal(f.calls.length, 3); assert.equal(f.writes.length, 0);
});
test("the starting after_id participates in cycle detection", async () => {
  const f = fixture(() => page("first", true, "same"), "anthropic", "https://catalog.fixture.invalid/v1/models?after_id=same");
  await assert.rejects(f.run(), /cursor|continuation|pagination/i);
  assert.equal(f.calls.length, 1);
});
test("page budget failure never publishes a partial catalog", async () => {
  const f = fixture((_request, index) => page(String(index), true));
  await assert.rejects(f.publish(), /limit|pages|pagination/i);
  assert.equal(f.calls.length, 100); assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("a complete catalog at the page budget is accepted", async () => {
  const f = fixture((_request, index) => page(String(index), index < 100));
  assert.equal(ids(await f.run()).length, 100);
});
for (const status of [401, 429, 500]) test(`later HTTP ${status} preserves the old cache`, async () => {
  const f = fixture((_request, index) => index === 1 ? page("first", true) : new Response("later failure", { status }));
  await assert.rejects(f.publish(), (error: unknown) => (error as { statusCode?: number }).statusCode === status);
  assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("later network failure preserves its cause and the old cache", async () => {
  const reason = new Error("offline");
  const f = fixture((_request, index) => { if (index > 1) throw reason; return page("first", true); });
  await assert.rejects(f.publish(), error => error === reason);
  assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
for (const body of [{}, { data: [], has_more: "true" }, { has_more: false }, { data: [] }]) test(`malformed later page ${JSON.stringify(body)} never publishes a prefix`, async () => {
  const f = fixture((_request, index) => index === 1 ? page("first", true) : Response.json(body));
  await assert.rejects(f.publish(), /pagination|page/i);
  assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("a fully assembled catalog is published once complete", async () => {
  const f = fixture((_request, index) => {
    assert.equal(f.restored.length, 0); assert.equal(f.writes.length, 0);
    return page(String(index), index < 2);
  });
  assert.deepEqual(Array.from(await f.publish(), entry => entry.id), ["1", "2"]);
  assert.equal(f.restored.length, 1); assert.equal(f.writes.length, 2, "source-key cache and legacy alias mirror");
});
for (const kind of ["cancel", "timeout"] as const) test(`${kind} after a page prevents further requests and publication`, async () => {
  const controller = new AbortController(); const reason = new Error(kind);
  const f = fixture(() => { (kind === "cancel" ? controller : f.timeout).abort(reason); return page("first", true); });
  await assert.rejects(f.publish(controller.signal), error => error === reason);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("Anthropic never reuses first-page validators as whole-catalog validators", async () => {
  const f = fixture((request, index) => {
    assert.equal(request.headers.has("if-none-match"), false);
    assert.equal(request.headers.has("if-modified-since"), false);
    return page(String(index), index === 1, String(index), { etag: '"page"', "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" });
  });
  const value = await f.run();
  assert.equal(value.etag, undefined); assert.equal(value.lastModified, undefined);
  assert.equal(value.notModified, false); assert.equal(ids(value).length, 2);
});
test("unsolicited Anthropic 304 cannot bless a cached partial catalog", async () => {
  const f = fixture(() => new Response(null, { status: 304 }));
  await assert.rejects(f.publish(), /304/);
  assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("a later 304 cannot turn a partial result into cache success", async () => {
  const f = fixture((_request, index) => index === 1 ? page("first", true) : new Response(null, { status: 304 }));
  await assert.rejects(f.publish(), /304/); assert.equal(f.writes.length, 0); assert.equal(f.restored.length, 0);
});
test("non-Anthropic validators and single-response behavior remain unchanged", async () => {
  const f = fixture(request => { assert.equal(request.headers.get("if-none-match"), '"old"'); return new Response(null, { status: 304 }); }, "openai-compatible");
  assert.equal((await f.run()).notModified, true); assert.equal(f.calls.length, 1);
  const other = fixture(() => page("first", true), "openai-compatible");
  assert.deepEqual(ids(await other.run()), ["first"]); assert.equal(other.calls.length, 1);
});
test("legacy Anthropic-compatible single-page bodies remain supported", async () => {
  const f = fixture(() => Response.json({ data: [{ id: "legacy" }] }));
  assert.deepEqual(ids(await f.run()), ["legacy"]); assert.equal(f.calls.length, 1);
});
test("a complete models-format page preserves the existing parser contract", async () => {
  const f = fixture(() => Response.json({ models: [{ id: "legacy" }], has_more: false }));
  assert.deepEqual(ids(await f.run()), ["legacy"]); assert.equal(f.calls.length, 1);
  const later = fixture((_request, index) => index === 1 ? page("first", true) : Response.json({ models: [{ id: "last" }], has_more: false }));
  assert.deepEqual(ids(await later.run()), ["first", "last"]);
});
test("a nonterminal incompatible page is not silently accepted", async () => {
  const f = fixture(() => Response.json({ models: [{ id: "legacy" }], has_more: true, last_id: "legacy" }));
  await assert.rejects(f.publish(), /pagination/); assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0);
});
test("reverse pagination is rejected explicitly rather than mixing before_id and after_id", async () => {
  const f = fixture(() => page("first", true), "anthropic", "https://catalog.fixture.invalid/v1/models?before_id=last");
  await assert.rejects(f.publish(), /before_id|reverse/i);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0);
});
