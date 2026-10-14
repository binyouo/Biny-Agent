import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute only reviewed actual declarations, never import a product module.
// The store below is an inert Map: no disk, SDK, Host, credentials or requests.
const root = process.env.BINY_CATALOG_SOURCE_ROOT ?? process.cwd();
const sourceRoot = process.env.BINY_CATALOG_BASELINE_ROOT ?? root;
function parse(relative: string): ts.SourceFile {
  const file = path.join(sourceRoot, relative);
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `one actual declaration for ${name}`);
  return matches[0]!;
}
const storeSource = parse("src/llm/ModelsStore.ts");
const catalogSource = parse("src/ai/modelCatalog.ts");
const providerSource = parse("src/ai/provider.ts");
const names = ["modelCatalogCacheKey", "normalizeCatalogEndpoint", "readProviderCatalog", "catalogForSource", "restoreProviderCatalogs"];
const selected: Array<[ts.SourceFile, ts.Node]> = names.map(name => [storeSource, declaration(storeSource, name)]);
selected.push([catalogSource, declaration(catalogSource, "defaultModelsEndpoint")], [providerSource, declaration(providerSource, "providerProtocol")]);

// Take the real URL-selection statements from fetchModelCatalogSnapshot, not a
// hand-written equivalent. Only protocol/endpoint declarations are admitted.
const requestBody = declaration(catalogSource, "fetchModelCatalogSnapshot").body!;
const endpointStatements = ["protocol", "endpoint"].map(name => {
  const matches = requestBody.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.length === 1
    && ts.isIdentifier(node.declarationList.declarations[0]!.name)
    && node.declarationList.declarations[0]!.name.getText(catalogSource) === name);
  assert.equal(matches.length, 1, `one actual URL-selection statement for ${name}`);
  return matches[0]!;
});
for (const node of endpointStatements) selected.push([catalogSource, node]);

const calls = new Set([
  "config.modelsEndpoint?.trim", '(config.baseUrl ?? "").trim', '(config.baseUrl ?? "").trim().replace',
  "normalizeCatalogEndpoint", "JSON.stringify", "character.codePointAt", "Math.imul", '(hash >>> 0).toString', '(hash >>> 0).toString(16).padStart',
  '/^(https?):\\/\\/([^/\\\\?#]*)([\\s\\S]*)$/iu.exec', "authority.lastIndexOf", "authority.slice", "hostAndPort.startsWith", "hostAndPort.indexOf", "hostAndPort.slice", "hostAndPort.slice(0, hostEnd).toLowerCase", "scheme!.toLowerCase",
  "modelCatalogCacheKey", "catalogForSource", "store.read", "store.read(cacheKey).catch", "store.read(providerId).catch",
  "providerIds.flatMap", "providerIds.map", "store.readMany", "store.readMany([...new Set(cacheKeys)]).catch", "entries.get", "Promise.all", "readProviderCatalog", "restored.filter",
  "baseUrl.replace", '/\\/v1$/u.test', "providerProtocol", "defaultModelsEndpoint"
]);
for (const [file, node] of selected) {
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child) && !ts.isImportEqualsDeclaration(child));
    if (ts.isIdentifier(child)) assert.ok(!["process", "globalThis", "require", "fetch", "eval", "Function"].includes(child.text));
    if (ts.isNewExpression(child)) {
      assert.ok(["Map", "Set"].includes(child.expression.getText(file)));
      assert.ok((child.arguments?.length ?? 0) <= 1);
    }
    if (ts.isCallExpression(child)) assert.ok(calls.has(child.expression.getText(file)), `unreviewed call: ${child.expression.getText(file)}`);
    ts.forEachChild(child, visit);
  };
  visit(node);
}
const functions = selected.slice(0, names.length + 2).map(([file, node]) => node.getText(file).replace(/^export /u, ""));
const source = functions.join("\n") + `\nfunction requestEndpoint(request) {\n${endpointStatements.map(node => node.getText(catalogSource)).join("\n")}\nreturn endpoint;\n}\n({ ${names.join(", ")}, requestEndpoint });`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Config { type: string; protocol?: "anthropic" | "openai-compatible"; baseUrl?: string; modelsEndpoint?: string }
interface Model { id: string; contextWindow: number }
interface Entry { models: Model[]; sourceKey?: string; etag?: string; lastModified?: number }
interface Store {
  read(key: string): Promise<Entry | undefined>;
  readMany?(keys: readonly string[]): Promise<Map<string, Entry>>;
}
interface Pure {
  modelCatalogCacheKey(alias: string, config: Config): string;
  normalizeCatalogEndpoint(endpoint: string): string;
  readProviderCatalog(alias: string, config: Config, store: Store): Promise<Entry | undefined>;
  catalogForSource(entry: Entry | undefined, key: string, exact: boolean): Entry | undefined;
  restoreProviderCatalogs(ids: readonly string[], store: Store, providers?: Record<string, Config>): Promise<Array<[string, Model[]]>>;
  requestEndpoint(request: { config: Config; definition: { protocol: "anthropic" | "openai-compatible"; baseUrl?: string } }): string | undefined;
}
const api = runInNewContext(compiled.outputText, {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as Pure;
const alias = "gateway";
const a: Config = { type: "openai-compatible", baseUrl: "https://gateway.example/api", protocol: "openai-compatible" };
const b: Config = { ...a, protocol: "anthropic" };
const key = (config: Config): string => api.modelCatalogCacheKey(alias, config);
const entry = (window: number, sourceKey?: string): Entry => ({ models: [{ id: "custom-chat", contextWindow: window }], sourceKey, etag: '"resource-local-v1"', lastModified: 123 });
function inert(batch: boolean) {
  const entries = new Map<string, Entry>();
  const reads: string[] = [];
  const store: Store = { read: async name => { reads.push(name); return entries.get(name); } };
  if (batch) store.readMany = async ids => {
    reads.push(...ids);
    return new Map(ids.flatMap(id => entries.has(id) ? [[id, entries.get(id)!] as const] : []));
  };
  return { entries, reads, store };
}
function oldKey(endpoint: string, version: "v1" | "v2"): string {
  let hash = 2166136261;
  for (const character of `openai-compatible\0${endpoint}`) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); }
  return `${alias}::${version === "v2" ? "v2::" : ""}${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

test("actual URL selection changes with protocol and cache identity follows it", () => {
  const definition = { protocol: "openai-compatible" as const };
  assert.equal(api.requestEndpoint({ config: a, definition }), "https://gateway.example/api/models");
  assert.equal(api.requestEndpoint({ config: b, definition }), "https://gateway.example/api/v1/models");
  assert.notEqual(key(a), key(b));
  assert.match(key(a), /^gateway::v4::[a-f0-9]{8}$/u);
});

test("default endpoints remain scoped and undefined protocol is conservatively distinct", () => {
  const initial: Config = { type: "anthropic" };
  const other: Config = { ...initial, protocol: "openai-compatible" };
  const definition = { protocol: "anthropic" as const, baseUrl: "https://api.anthropic.com" };
  assert.equal(api.requestEndpoint({ config: initial, definition }), "https://api.anthropic.com/v1/models");
  assert.equal(api.requestEndpoint({ config: other, definition }), "https://api.anthropic.com/models");
  assert.notEqual(key(initial), key(other));
  assert.notEqual(key(initial), alias);
  assert.notEqual(key(initial), key({ ...initial, protocol: "anthropic" }));
  assert.equal(key(initial), key({ ...initial }));
});

test("resource-sensitive normalization and existing endpoint equivalence stay unchanged", () => {
  const base: Config = { type: "openai-compatible", baseUrl: "https://gateway.example/Plan-A/v1" };
  assert.equal(key(base), key({ ...base, baseUrl: "HTTPS://GATEWAY.EXAMPLE/Plan-A/v1///" }));
  assert.notEqual(key(base), key({ ...base, baseUrl: "https://gateway.example/plan-a/v1" }));
  assert.notEqual(key({ ...base, modelsEndpoint: "https://gateway.example/models?team=A" }), key({ ...base, modelsEndpoint: "https://gateway.example/models?team=a" }));
  assert.notEqual(key({ ...base, modelsEndpoint: "https://gateway.example/models/" }), key({ ...base, modelsEndpoint: "https://gateway.example/models" }));
  assert.equal(key({ ...base, modelsEndpoint: base.baseUrl }), key(base));
  assert.equal(api.normalizeCatalogEndpoint("HTTPS://HOST:0443/Case?Team=A#Part"), "https://host:0443/Case?Team=A#Part");
  // Counterexamples: /v1 and an explicit endpoint need not change URL. Conservative
  // protocol partitioning is still intentional; this test claims no URL change.
  const definition = { protocol: "openai-compatible" as const };
  assert.equal(api.requestEndpoint({ config: { ...a, baseUrl: "https://gateway.example/v1" }, definition }), api.requestEndpoint({ config: { ...b, baseUrl: "https://gateway.example/v1" }, definition }));
  assert.equal(api.requestEndpoint({ config: { ...a, modelsEndpoint: "https://gateway.example/catalog" }, definition }), api.requestEndpoint({ config: { ...b, modelsEndpoint: "https://gateway.example/catalog" }, definition }));
});

for (const batch of [true, false]) {
  test(`actual readers isolate protocol A → B → A (${batch ? "batch" : "single"})`, async () => {
    const { entries, store } = inert(batch);
    const first = entry(200_000, key(a));
    entries.set(key(a), first); entries.set(alias, first);
    assert.equal(await api.readProviderCatalog(alias, b, store), undefined);
    assert.equal((await api.restoreProviderCatalogs([alias], store, { [alias]: b })).length, 0);
    const second = entry(32_000, key(b));
    entries.set(key(b), second); entries.set(alias, second);
    for (const [config, expected] of [[a, 200_000], [b, 32_000], [a, 200_000]] as const) {
      assert.equal((await api.readProviderCatalog(alias, config, store))?.models[0]?.contextWindow, expected);
      assert.equal((await api.restoreProviderCatalogs([alias], store, { [alias]: config }))[0]?.[1][0]?.contextWindow, expected);
    }
  });

  test(`old scoped and unproven alias caches do not cross into v4 (${batch ? "batch" : "single"})`, async () => {
    for (const version of ["v1", "v2"] as const) {
      for (const provenance of [false, true]) {
        const { entries, store } = inert(batch);
        const old = oldKey(a.baseUrl!, version);
        const previous = entry(200_000, provenance ? old : undefined);
        entries.set(old, previous); entries.set(alias, previous);
        const before = JSON.stringify([...entries]);
        assert.equal(await api.readProviderCatalog(alias, a, store), undefined);
        assert.equal((await api.restoreProviderCatalogs([alias], store, { [alias]: a })).length, 0);
        assert.equal((await api.restoreProviderCatalogs([alias], store))[0]?.[1][0]?.contextWindow, 200_000);
        assert.equal(JSON.stringify([...entries]), before, "reads never rewrite or delete legacy data");
      }
    }
  });

  test(`matching mirror and current exact key retain validators (${batch ? "batch" : "single"})`, async () => {
    const { entries, store } = inert(batch);
    const mirror = entry(200_000, key(a));
    entries.set(alias, mirror);
    assert.equal(await api.readProviderCatalog(alias, a, store), mirror);
    assert.equal((await api.restoreProviderCatalogs([alias], store, { [alias]: a }))[0]?.[1][0]?.contextWindow, 200_000);
    entries.clear();
    entries.set(key(a), entry(32_000));
    const restored = await api.readProviderCatalog(alias, a, store);
    assert.equal(restored?.sourceKey, key(a));
    assert.equal(restored?.etag, '"resource-local-v1"');
    assert.equal(restored?.lastModified, 123);
    assert.equal((await api.restoreProviderCatalogs([alias], store, { [alias]: a }))[0]?.[1][0]?.contextWindow, 32_000);
  });
}

test("source gate rejects mismatches even at an exact key and preserves input objects", () => {
  const unknown = entry(200_000);
  const before = JSON.stringify(unknown);
  assert.equal(api.catalogForSource(unknown, key(a), false), undefined);
  assert.equal(api.catalogForSource(entry(200_000, key(b)), key(a), true), undefined);
  assert.equal(api.catalogForSource(undefined, key(a), true), undefined);
  assert.equal(api.catalogForSource(unknown, key(a), true)?.sourceKey, key(a));
  assert.equal(JSON.stringify(unknown), before);
});
