import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { defaultConfig, type AgentConfig, type McpServerConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createCredentialStore } from "../src/config/credentials.js";
import { DesktopMcpService } from "../src/desktop/electron/main/DesktopMcpService.js";
import type { DesktopMcpServerDraft } from "../src/desktop/protocol.js";
import { isToolModelVisible, isToolScriptCallable } from "../src/tools/exposure.js";

// Only the private pure policy lookup is extracted. Service, schema, CAS and
// persistence below execute their complete production modules against real files.
const source = ts.createSourceFile("mcp.ts", readFileSync(new URL("../src/extensions/mcp.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const lookup = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "resolveMcpToolExposure");
assert.ok(lookup);
const exposure = runInNewContext(stripTypeScriptTypes(lookup.getText(source)) + "\nresolveMcpToolExposure;", {}, { timeout: 1_000 }) as (config: McpServerConfig, name: string) => NonNullable<McpServerConfig["exposure"]>;
const loaded = { exposure, visible: isToolModelVisible, callable: isToolScriptCallable };
const existingId = "00000000-0000-4000-8000-000000000001";
function draft(transport: "stdio" | "remote" = "stdio", name = "policy"): DesktopMcpServerDraft {
  return { name, description: "edited", transport, command: "unused", args: [], url: "https://fixture.invalid/mcp", env: [], headers: [], startupTimeoutMs: 12_000, timeoutMs: 90_000 };
}
function server(policy: Partial<McpServerConfig> = {}, transport: "stdio" | "remote" = "stdio"): McpServerConfig {
  return { id: existingId, enabled: true, args: [], stderr: "ignore", ...(transport === "stdio" ? { command: "unused" } : { type: "http", url: "https://fixture.invalid/mcp" }), ...policy };
}
async function fixture(context: TestContext, original?: McpServerConfig, options: { project?: string; failSave?: boolean; concurrentPolicy?: Partial<McpServerConfig> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-mcp-policy-"));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const workspace = path.join(root, "project"), globalDir = path.join(root, "global");
  await fs.mkdir(workspace); await fs.mkdir(globalDir);
  const store = createFileConfigStore(workspace, { globalDir, credentialStore: createCredentialStore("linux") });
  const initial = structuredClone(defaultConfig);
  initial.extensions.mcp = { sibling: server({ id: "00000000-0000-4000-8000-000000000003", exposure: "hidden", toolExposure: { secret: "hidden" } }) };
  if (original) initial.extensions.mcp.policy = original;
  await store.save(initial);
  const before = await store.loadVersioned!(workspace), current = before.config;
  let durable = current, saved: AgentConfig | undefined;
  const calls: string[] = [];
  const agents = {
    assertNoRunningTasks: () => { calls.push("admission"); },
    refreshMcpRuntimes: async () => { calls.push("refresh"); },
    mcpStatuses: async () => [],
    mcpReconnect: async () => { throw new Error("Unexpected connection"); },
    mcpDetails: async () => { throw new Error("Unexpected connection"); }
  };
  const projects = { requireProject: (id: string) => { assert.equal(id, options.project); return { path: workspace }; } };
  const service = new DesktopMcpService(store, projects as never, agents, async () => { throw new Error("Unexpected network access"); });
  if (options.concurrentPolicy) {
    const next = structuredClone(current);
    next.extensions.mcp.policy = { ...next.extensions.mcp.policy!, ...options.concurrentPolicy };
    durable = (await store.saveVersioned!(next, before.revision, workspace)).config;
  }
  if (options.failSave) {
    const rename = fs.rename;
    const canonicalGlobal = await fs.realpath(globalDir);
    context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (path.basename(String(args[1])) === "config.json" && await fs.realpath(path.dirname(String(args[1]))) === canonicalGlobal) {
        throw Object.assign(new Error("save failed"), { code: "EIO" });
      }
      return await rename(...args);
    });
  }
  return {
    current, calls, loaded, get saved() { return saved; }, get durable() { return durable; },
    run: async (next = draft(), old: string | undefined = original ? "policy" : undefined, expected = before.revision) => {
      try {
        await service.upsertServer(options.project, old, next, expected);
        calls.push("snapshot");
        saved = (await store.loadVersioned!(workspace)).config;
        return saved;
      } finally { durable = (await store.loadVersioned!(workspace)).config; }
    }
  };
}
for (const transport of ["stdio", "remote"] as const) for (const exposure of ["hidden", "direct", "codemode", "deferred"] as const) test(`${transport}: edit preserves server ${exposure}`, async t => {
  const f = await fixture(t, server({ exposure }, transport)); const actual = (await f.run(draft(transport))).extensions.mcp.policy!;
  assert.equal(actual.exposure, exposure); assert.equal(f.loaded.exposure(actual, "delete"), exposure);
  assert.equal(actual.description, "edited"); assert.equal(actual.timeoutMs, 90_000);
  assert.deepEqual(f.calls, ["admission", "refresh", "snapshot"]);
});
const overrides: NonNullable<McpServerConfig["toolExposure"]> = { "*": "codemode", "list*": "direct", list_private: "hidden", update: "deferred" };
for (const rename of [false, true]) for (const transport of ["stdio", "remote"] as const) test(`policy survives rename=${rename} and transport switch to ${transport}`, async t => {
  const original = server({ exposure: "hidden", toolExposure: { ...overrides }, toolContracts: { write: "file-change-v1" } }, transport === "stdio" ? "remote" : "stdio");
  const f = await fixture(t, original, { project: "project-a" }); const name = rename ? "renamed" : "policy";
  const result = await f.run(draft(transport, name)); const actual = result.extensions.mcp[name]!;
  assert.deepEqual(actual.toolExposure, overrides); assert.equal(actual.exposure, "hidden"); assert.equal(actual.id, existingId);
  assert.deepEqual(actual.toolContracts, { write: "file-change-v1" });
  if (rename) assert.equal(Object.hasOwn(result.extensions.mcp, "policy"), false);
  for (const [tool, expected] of Object.entries({ list: "direct", list_private: "hidden", update: "deferred", other: "codemode" })) assert.equal(f.loaded.exposure(actual, tool), expected);
  assert.equal(f.loaded.visible({ exposure: f.loaded.exposure(actual, "list_private") }), false);
  assert.equal(f.loaded.callable({ exposure: f.loaded.exposure(actual, "list_private") }, true), false);
  assert.deepEqual(result.extensions.mcp.sibling, f.current.extensions.mcp.sibling); assert.deepEqual(result.agent, f.current.agent);
  assert.notEqual(actual.toolExposure, original.toolExposure, "schema publication owns its policy map");
  actual.toolExposure!.list_private = "direct"; assert.equal(original.toolExposure!.list_private, "hidden");
  assert.notEqual(result.extensions.mcp.sibling!.toolExposure, f.current.extensions.mcp.sibling!.toolExposure);
});
for (const policy of [{}, { exposure: undefined, toolExposure: undefined }, { toolExposure: {} }]) test(`absent/undefined/empty policy: ${JSON.stringify(policy)} keys=${Object.keys(policy).length}`, async t => {
  const f = await fixture(t, server(policy)); const actual = (await f.run()).extensions.mcp.policy!;
  assert.equal(actual.exposure, undefined); assert.deepEqual(actual.toolExposure, policy.toolExposure); assert.equal(f.loaded.exposure(actual, "anything"), "deferred");
});
for (const transport of ["stdio", "remote"] as const) test(`new ${transport} server does not inherit sibling policy`, async t => {
  const f = await fixture(t, ); const result = await f.run(draft(transport)); const actual = result.extensions.mcp.policy!;
  assert.match(actual.id!, /^[0-9a-f-]{36}$/u); assert.notEqual(actual.id, existingId); assert.notEqual(actual.id, result.extensions.mcp.sibling!.id); assert.equal(actual.exposure, undefined); assert.equal(actual.toolExposure, undefined);
  assert.equal(f.loaded.exposure(actual, "secret"), "deferred"); assert.equal(result.extensions.mcp.sibling!.exposure, "hidden");
});
test("draft cannot inject policy; existing configuration owns it", async t => {
  const f = await fixture(t, server({ exposure: "hidden", toolExposure: { secret: "hidden" } }));
  const actual = (await f.run(Object.assign(draft(), { exposure: "direct" as const, toolExposure: { secret: "direct" as const } }))).extensions.mcp.policy!;
  assert.equal(actual.exposure, "hidden"); assert.deepEqual(actual.toolExposure, { secret: "hidden" });
});
for (const kind of ["stale revision", "missing original", "name collision", "schema error", "save failure"] as const) test(`${kind} does not refresh or publish success`, async t => {
  const f = await fixture(t, server({ exposure: "hidden", toolExposure: { secret: "hidden" } }), { failSave: kind === "save failure" }); const input = draft();
  if (kind === "name collision") input.name = "sibling"; if (kind === "schema error") input.timeoutMs = 1;
  await assert.rejects(f.run(input, kind === "missing original" ? "missing" : "policy", kind === "stale revision" ? "stale" : undefined));
  assert.equal(f.saved, undefined); assert.equal(f.calls.includes("refresh"), false); assert.equal(f.calls.includes("snapshot"), false);
  assert.equal(f.current.extensions.mcp.policy!.exposure, "hidden");
});
test("unchanged form save preserves policies absent from the form", async t => {
  const original = server({ description: "edited", exposure: "hidden", toolExposure: { private: "hidden" }, startupTimeoutMs: 12_000, timeoutMs: 90_000 });
  const f = await fixture(t, original); const actual = (await f.run()).extensions.mcp.policy!;
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify({ ...f.current.extensions.mcp.policy, type: "stdio" })));
});
test("map-only policy preserves exact prototype-named tools without merging keys into server", async t => {
  const original = server({ toolExposure: { constructor: "hidden" as const, toString: "direct" as const, "*": "deferred" } });
  const f = await fixture(t, original); const actual = (await f.run()).extensions.mcp.policy!;
  assert.equal(actual.exposure, undefined);
  assert.equal(f.loaded.exposure(actual, "constructor"), "hidden"); assert.equal(f.loaded.exposure(actual, "toString"), "direct");
  assert.equal(Object.hasOwn(actual, "constructor"), false); assert.equal(Object.hasOwn(actual, "toString"), false);
  assert.equal(Object.getPrototypeOf(actual.toolExposure), Object.prototype);
  assert.notEqual(actual.toolExposure, original.toolExposure);
});
test("undefined policy fields are not serialized as configured policies", async t => {
  const f = await fixture(t, server({ exposure: undefined, toolExposure: undefined }));
  const actual = JSON.parse(JSON.stringify((await f.run()).extensions.mcp.policy)) as Record<string, unknown>;
  assert.equal(Object.hasOwn(actual, "exposure"), false); assert.equal(Object.hasOwn(actual, "toolExposure"), false);
});

for (const policy of [{ exposure: "codemode" as const }, { toolExposure: { secret: "deferred" as const } }]) test(`concurrent policy change survives stale edit: ${Object.keys(policy).join()}`, async t => {
  const f = await fixture(t, server({ exposure: "hidden", toolExposure: { secret: "hidden" } }), { concurrentPolicy: policy });
  await assert.rejects(f.run(), /MCP 配置已被其他客户端修改/u);
  assert.equal(f.saved, undefined); assert.equal(f.calls.includes("refresh"), false); assert.equal(f.calls.includes("snapshot"), false);
  for (const [key, value] of Object.entries(policy)) assert.deepEqual(f.durable.extensions.mcp.policy![key as keyof McpServerConfig], value);
  assert.equal(f.current.extensions.mcp.policy!.exposure, "hidden"); assert.equal(f.current.extensions.mcp.policy!.toolExposure!.secret, "hidden");
});
