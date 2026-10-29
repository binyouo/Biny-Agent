import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import type { McpServerConfig } from "../src/config/schema.js";
import type { DesktopMcpServerDraft } from "../src/desktop/protocol.js";

// Execute only selected production methods/helpers, with inert configuration I/O.
// No product imports, MCP construction, credentials, network, filesystem writes or runtime startup.
function source(relative: string) {
  return ts.createSourceFile(relative, readFileSync(new URL(relative, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}
const serviceSource = source("../src/desktop/electron/main/DesktopMcpService.ts");
const schemaSource = source("../src/config/schema.ts");
const versionSource = source("../src/config/versioned.ts");
const conflict = versionSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ConfigRevisionConflictError");
assert.ok(conflict);
const storeSource = source("../src/config/store.ts");
const transaction = storeSource.statements.filter(ts.isClassDeclaration).flatMap(node => node.members)
  .find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(storeSource) === "saveVersionedTransaction");
assert.ok(transaction);
function functions(file: ts.SourceFile, names: string[]) {
  return names.map(name => {
    const node = file.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, name); return node.getText(file).replace(/^export /u, "");
  }).join("\n");
}
const service = serviceSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopMcpService");
assert.ok(service);
const methods = ["upsertServer", "workspaceRoot", "loadVersioned", "saveVersioned"].map(name => {
  const node = service.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && member.name.getText(serviceSource) === name);
  assert.ok(node, name); return node.getText(serviceSource);
});
const schema = schemaSource.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === "mcpServerSchema"));
assert.ok(schema);
const code = ts.transpileModule([
  schema.getText(schemaSource),
  conflict.getText(versionSource).replace(/^export /u, ""),
  functions(versionSource, ["configDocumentRevision", "assertConfigRevision", "stableJson"]),
  `class SelectedStore { ${transaction.getText(storeSource)} }`,
  // Only the global envelope is a seam; the complete real MCP schema validates and clones each server.
  'const configSchema = z.object({ extensions: z.object({ mcp: z.record(z.string(), mcpServerSchema) }).passthrough() }).passthrough();',
  functions(serviceSource, ["buildServerConfig", "applyFieldMutations", "mcpCredentialAccount", "isEnvironmentReference", "normalizeServerName", "validateFieldKey", "requiredText", "optionalText", "redactEndpoint"]),
  functions(source("../src/extensions/mcp.ts"), ["resolveMcpToolExposure"]),
  functions(source("../src/tools/exposure.ts"), ["getToolExposure", "isToolModelVisible", "isToolScriptCallable"]),
  `class SelectedService { ${methods.join("\n")} }`,
  "this.revision = configDocumentRevision; this.Store = SelectedStore; this.Service = SelectedService; this.exposure = resolveMcpToolExposure; this.visible = isToolModelVisible; this.callable = isToolScriptCallable;"
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Config = { providers: Record<string, never>; extensions: { mcp: Record<string, McpServerConfig> }; marker: string };
type Service = { upsertServer(project: string | undefined, original: string | undefined, draft: DesktopMcpServerDraft, revision: string): Promise<Config> };
const existingId = "00000000-0000-4000-8000-000000000001", newId = "00000000-0000-4000-8000-000000000002";
function draft(transport: "stdio" | "remote" = "stdio", name = "policy"): DesktopMcpServerDraft {
  return { name, description: "edited", transport, command: "unused", args: [], url: "https://fixture.invalid/mcp", env: [], headers: [], startupTimeoutMs: 12_000, timeoutMs: 90_000 };
}
function server(policy: Partial<McpServerConfig> = {}, transport: "stdio" | "remote" = "stdio"): McpServerConfig {
  return { id: existingId, enabled: true, args: [], stderr: "ignore", ...(transport === "stdio" ? { command: "unused" } : { type: "http", url: "https://fixture.invalid/mcp" }), ...policy };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixture(original?: McpServerConfig, options: { project?: string; failSave?: boolean; concurrentPolicy?: Partial<McpServerConfig> } = {}) {
  const current = freeze<Config>({ providers: {}, extensions: { mcp: { ...(original ? { policy: original } : {}), sibling: server({ id: "00000000-0000-4000-8000-000000000003", exposure: "hidden", toolExposure: { secret: "hidden" } }) } }, marker: "unrelated" });
  const calls: string[] = [];
  let saved: Config | undefined;
  const sandbox = { z, URL, structuredClone, createHash, randomUUID: () => newId, maxServerNameLength: 120, maxFieldKeyLength: 200, desktopComputerMcpName: "computer-use", globalConfigDir: () => "/fixture/global" };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } }); vm.runInContext(code, sandbox);
  const loaded = sandbox as typeof sandbox & { revision(config: Config): string; Store: new () => { saveVersionedTransaction(config: Config, expected: string, root: string): Promise<unknown> }; Service: new () => Service; exposure(config: McpServerConfig, name: string): string; visible(tool: { exposure: string }): boolean; callable(tool: { exposure: string }, selected: boolean): boolean };
  const revision = loaded.revision(current);
  let durable = current;
  const backend = Object.assign(new loaded.Store(), {
    transaction: async (action: () => Promise<unknown>) => {
      if (options.concurrentPolicy) {
        durable = structuredClone(current);
        Object.assign(durable.extensions.mcp.policy!, options.concurrentPolicy);
      }
      return await action();
    },
    loadUnlocked: async () => durable,
    saveUnlocked: async (next: Config) => { if (options.failSave) throw new Error("save failed"); saved = next; durable = next; }
  });
  const receiver = Object.assign(new loaded.Service(), {
    loginServers: new Map(), projects: { requireProject: (id: string) => { assert.equal(id, options.project); return { path: "/fixture/project" }; } },
    configStore: {
      loadVersioned: async (root: string) => { assert.equal(root, options.project ? "/fixture/project" : "/fixture/global"); calls.push("load"); return { config: current, revision }; },
      saveVersioned: async (next: Config, expected: string, root: string) => {
        assert.equal(root, options.project ? "/fixture/project" : "/fixture/global"); assert.equal(expected, revision); calls.push("save");
        return await backend.saveVersionedTransaction(next, expected, root);
      }
    },
    agents: { assertNoRunningTasks: () => { calls.push("admission"); }, refreshMcpRuntimes: async () => { assert.ok(saved); calls.push("refresh"); } },
    snapshot: async (project: string | undefined) => { assert.equal(project, options.project); calls.push("snapshot"); return saved!; }
  });
  return { current, calls, loaded, get saved() { return saved; }, get durable() { return durable; }, run: (next = draft(), old: string | undefined = original ? "policy" : undefined, expected = revision) => receiver.upsertServer(options.project, old, next, expected) };
}
for (const transport of ["stdio", "remote"] as const) for (const exposure of ["hidden", "direct", "codemode", "deferred"] as const) test(`${transport}: edit preserves server ${exposure}`, async () => {
  const f = fixture(server({ exposure }, transport)); const actual = (await f.run(draft(transport))).extensions.mcp.policy!;
  assert.equal(actual.exposure, exposure); assert.equal(f.loaded.exposure(actual, "delete"), exposure);
  assert.equal(actual.description, "edited"); assert.equal(actual.timeoutMs, 90_000);
  assert.deepEqual(f.calls, ["admission", "load", "save", "refresh", "snapshot"]);
});
const overrides: NonNullable<McpServerConfig["toolExposure"]> = { "*": "codemode", "list*": "direct", list_private: "hidden", update: "deferred" };
for (const rename of [false, true]) for (const transport of ["stdio", "remote"] as const) test(`policy survives rename=${rename} and transport switch to ${transport}`, async () => {
  const original = server({ exposure: "hidden", toolExposure: { ...overrides }, toolContracts: { write: "file-change-v1" } }, transport === "stdio" ? "remote" : "stdio");
  const f = fixture(original, { project: "project-a" }); const name = rename ? "renamed" : "policy";
  const result = await f.run(draft(transport, name)); const actual = result.extensions.mcp[name]!;
  assert.deepEqual(actual.toolExposure, overrides); assert.equal(actual.exposure, "hidden"); assert.equal(actual.id, existingId);
  assert.deepEqual(actual.toolContracts, { write: "file-change-v1" });
  if (rename) assert.equal(Object.hasOwn(result.extensions.mcp, "policy"), false);
  for (const [tool, expected] of Object.entries({ list: "direct", list_private: "hidden", update: "deferred", other: "codemode" })) assert.equal(f.loaded.exposure(actual, tool), expected);
  assert.equal(f.loaded.visible({ exposure: f.loaded.exposure(actual, "list_private") }), false);
  assert.equal(f.loaded.callable({ exposure: f.loaded.exposure(actual, "list_private") }, true), false);
  assert.deepEqual(result.extensions.mcp.sibling, f.current.extensions.mcp.sibling); assert.equal(result.marker, f.current.marker);
  assert.notEqual(actual.toolExposure, original.toolExposure, "schema publication owns its policy map");
  actual.toolExposure!.list_private = "direct"; assert.equal(original.toolExposure!.list_private, "hidden");
  assert.notEqual(result.extensions.mcp.sibling!.toolExposure, f.current.extensions.mcp.sibling!.toolExposure);
});
for (const policy of [{}, { exposure: undefined, toolExposure: undefined }, { toolExposure: {} }]) test(`absent/undefined/empty policy: ${JSON.stringify(policy)} keys=${Object.keys(policy).length}`, async () => {
  const f = fixture(server(policy)); const actual = (await f.run()).extensions.mcp.policy!;
  assert.equal(actual.exposure, undefined); assert.deepEqual(actual.toolExposure, policy.toolExposure); assert.equal(f.loaded.exposure(actual, "anything"), "deferred");
});
for (const transport of ["stdio", "remote"] as const) test(`new ${transport} server does not inherit sibling policy`, async () => {
  const f = fixture(); const result = await f.run(draft(transport)); const actual = result.extensions.mcp.policy!;
  assert.equal(actual.id, newId); assert.equal(actual.exposure, undefined); assert.equal(actual.toolExposure, undefined);
  assert.equal(f.loaded.exposure(actual, "secret"), "deferred"); assert.equal(result.extensions.mcp.sibling!.exposure, "hidden");
});
test("draft cannot inject policy; existing configuration owns it", async () => {
  const f = fixture(server({ exposure: "hidden", toolExposure: { secret: "hidden" } }));
  const actual = (await f.run(Object.assign(draft(), { exposure: "direct" as const, toolExposure: { secret: "direct" as const } }))).extensions.mcp.policy!;
  assert.equal(actual.exposure, "hidden"); assert.deepEqual(actual.toolExposure, { secret: "hidden" });
});
for (const kind of ["stale revision", "missing original", "name collision", "schema error", "save failure"] as const) test(`${kind} does not refresh or publish success`, async () => {
  const f = fixture(server({ exposure: "hidden", toolExposure: { secret: "hidden" } }), { failSave: kind === "save failure" }); const input = draft();
  if (kind === "name collision") input.name = "sibling"; if (kind === "schema error") input.timeoutMs = 1;
  await assert.rejects(f.run(input, kind === "missing original" ? "missing" : "policy", kind === "stale revision" ? "stale" : undefined));
  assert.equal(f.saved, undefined); assert.equal(f.calls.includes("refresh"), false); assert.equal(f.calls.includes("snapshot"), false);
  assert.equal(f.current.extensions.mcp.policy!.exposure, "hidden");
});
test("unchanged form save preserves policies absent from the form", async () => {
  const original = server({ description: "edited", exposure: "hidden", toolExposure: { private: "hidden" }, startupTimeoutMs: 12_000, timeoutMs: 90_000 });
  const f = fixture(original); const actual = (await f.run()).extensions.mcp.policy!;
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), { ...original, type: "stdio" });
});
test("map-only policy preserves exact prototype-named tools without merging keys into server", async () => {
  const original = server({ toolExposure: { constructor: "hidden" as const, toString: "direct" as const, "*": "deferred" } });
  const f = fixture(original); const actual = (await f.run()).extensions.mcp.policy!;
  assert.equal(actual.exposure, undefined);
  assert.equal(f.loaded.exposure(actual, "constructor"), "hidden"); assert.equal(f.loaded.exposure(actual, "toString"), "direct");
  assert.equal(Object.hasOwn(actual, "constructor"), false); assert.equal(Object.hasOwn(actual, "toString"), false);
  assert.equal(Object.getPrototypeOf(actual.toolExposure), Object.prototype);
  assert.notEqual(actual.toolExposure, original.toolExposure);
});
test("undefined policy fields are not serialized as configured policies", async () => {
  const f = fixture(server({ exposure: undefined, toolExposure: undefined }));
  const actual = JSON.parse(JSON.stringify((await f.run()).extensions.mcp.policy)) as Record<string, unknown>;
  assert.equal(Object.hasOwn(actual, "exposure"), false); assert.equal(Object.hasOwn(actual, "toolExposure"), false);
});

for (const policy of [{ exposure: "codemode" as const }, { toolExposure: { secret: "deferred" as const } }]) test(`concurrent policy change survives stale edit: ${Object.keys(policy).join()}`, async () => {
  const f = fixture(server({ exposure: "hidden", toolExposure: { secret: "hidden" } }), { concurrentPolicy: policy });
  await assert.rejects(f.run(), /Global config revision conflict/);
  assert.equal(f.saved, undefined); assert.equal(f.calls.includes("refresh"), false); assert.equal(f.calls.includes("snapshot"), false);
  for (const [key, value] of Object.entries(policy)) assert.deepEqual(f.durable.extensions.mcp.policy![key as keyof McpServerConfig], value);
  assert.equal(f.current.extensions.mcp.policy!.exposure, "hidden"); assert.equal(f.current.extensions.mcp.policy!.toolExposure!.secret, "hidden");
});
