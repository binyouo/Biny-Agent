import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { loadPlugins } from "../src/extensions/plugins.js";
import { ToolRegistry } from "../src/tools/registry.js";

type Format = "mjs" | "cjs";
interface ProbeModule {
  default: unknown;
  register: unknown;
  getEvents(): string[];
}

const config = configSchema.parse(defaultConfig);
const toolHelper = `
const events = [];
function addTool(context, name, label) {
  context.registerTool({
    name, description: label, parameters: { type: "object" },
    schema: { parse: (value) => value },
    resolveExecution: () => ({ approvalRule: name, execute: async () => label })
  });
}
`;

async function fixture(t: TestContext, format: Format, body: string, exports: string): Promise<{
  workspaceRoot: string;
  filename: string;
  imported: ProbeModule;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-plugin-alias-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const filename = `plugin.${format}`;
  const filepath = path.join(workspaceRoot, filename);
  const getEvents = format === "mjs"
    ? "export function getEvents() { return [...events]; }"
    : "module.exports.getEvents = () => [...events];";
  await writeFile(filepath, `${toolHelper}\n${body}\n${exports}\n${getEvents}\n`, "utf8");
  // Use Node's actual module namespace, including its CommonJS named-export detection.
  const imported = await import(pathToFileURL(filepath).href) as ProbeModule;
  return { workspaceRoot, filename, imported };
}

function functionExports(format: Format, aliased: boolean): string {
  return format === "mjs"
    ? `export default defaultRegister; export { ${aliased ? "defaultRegister as register" : "register"} };`
    : `module.exports = defaultRegister; module.exports.register = ${aliased ? "defaultRegister" : "register"};`;
}

async function toolResult(registry: ToolRegistry, name: string): Promise<unknown> {
  const execution = await registry.get(name).resolveExecution({});
  assert.equal("isError" in execution, false);
  if ("isError" in execution) throw new Error("Unexpected tool resolution error");
  return await execution.execute({ toolCallId: "test", operationId: "test" });
}

for (const format of ["mjs", "cjs"] as const) {
  test(`${format}: aliased default and named callbacks install a tool exactly once`, async (t) => {
    const plugin = await fixture(t, format, `
function defaultRegister(context) {
  events.push("register");
  addTool(context, "alias_probe", "installed");
}`, functionExports(format, true));
    assert.equal(typeof plugin.imported.default, "function");
    assert.equal(plugin.imported.default, plugin.imported.register);
    const registry = new ToolRegistry();
    assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename, `./${plugin.filename}`], config, registry), [plugin.filename]);
    assert.deepEqual(plugin.imported.getEvents(), ["register"]);
    assert.deepEqual(registry.listEntries().map(({ source, tool }) => [source, tool.name]), [["plugin", "alias_probe"]]);
    assert.equal(await toolResult(registry, "alias_probe"), "installed");
  });

  test(`${format}: aliased side-effect-only callbacks execute once`, async (t) => {
    const plugin = await fixture(t, format, "function defaultRegister() { events.push(\"side effect\"); }", functionExports(format, true));
    assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, new ToolRegistry()), [plugin.filename]);
    assert.deepEqual(plugin.imported.getEvents(), ["side effect"]);
  });

  test(`${format}: distinct callbacks both run in awaited default-then-named order`, async (t) => {
    const plugin = await fixture(t, format, `
async function defaultRegister(context) {
  events.push("default:start");
  await Promise.resolve();
  addTool(context, "default_probe", "default");
  events.push("default:end");
}
async function register(context) {
  events.push("named:start");
  await Promise.resolve();
  addTool(context, "named_probe", "named");
  events.push("named:end");
}`, functionExports(format, false));
    assert.notEqual(plugin.imported.default, plugin.imported.register);
    const registry = new ToolRegistry();
    assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), [plugin.filename]);
    assert.deepEqual(plugin.imported.getEvents(), ["default:start", "default:end", "named:start", "named:end"]);
    assert.equal(await toolResult(registry, "default_probe"), "default");
    assert.equal(await toolResult(registry, "named_probe"), "named");
  });

  test(`${format}: cached imports register again for each fresh registry`, async (t) => {
    const plugin = await fixture(t, format, `
function defaultRegister(context) {
  events.push("register");
  addTool(context, "reload_probe", "registered again");
}`, functionExports(format, true));
    for (let count = 1; count <= 2; count += 1) {
      const registry = new ToolRegistry();
      assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), [plugin.filename]);
      assert.equal(plugin.imported.getEvents().length, count);
      assert.equal(await toolResult(registry, "reload_probe"), "registered again");
    }
  });

  test(`${format}: distinct callbacks with a duplicate tool name still fail after partial registration`, async (t) => {
    const plugin = await fixture(t, format, `
function defaultRegister(context) {
  events.push("default");
  addTool(context, "duplicate_probe", "first");
}
function register(context) {
  events.push("named");
  addTool(context, "duplicate_probe", "second");
  events.push("after duplicate");
}`, functionExports(format, false));
    const registry = new ToolRegistry();
    await assert.rejects(loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), /^Error: Tool already registered: duplicate_probe$/);
    assert.deepEqual(plugin.imported.getEvents(), ["default", "named"]);
    assert.equal(registry.list().length, 1);
    assert.equal(await toolResult(registry, "duplicate_probe"), "first");
  });

  test(`${format}: reloading into the same registry still rejects a real duplicate`, async (t) => {
    const plugin = await fixture(t, format, `
function defaultRegister(context) {
  events.push("register");
  addTool(context, "existing_probe", "first");
}`, functionExports(format, true));
    const registry = new ToolRegistry();
    await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry);
    await assert.rejects(loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), /Tool already registered: existing_probe/);
    assert.deepEqual(plugin.imported.getEvents(), ["register", "register"]);
    assert.equal(await toolResult(registry, "existing_probe"), "first");
  });

  test(`${format}: an aliased callback failure still propagates with its partial registration`, async (t) => {
    const plugin = await fixture(t, format, `
function defaultRegister(context) {
  events.push("register");
  addTool(context, "partial_probe", "retained");
  throw new Error("plugin registration failed");
}`, functionExports(format, true));
    const registry = new ToolRegistry();
    await assert.rejects(loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), /^Error: plugin registration failed$/);
    assert.deepEqual(plugin.imported.getEvents(), ["register"]);
    assert.equal(await toolResult(registry, "partial_probe"), "retained");
  });

  test(`${format}: object-default and named register aliases retain their existing single invocation`, async (t) => {
    const exports = format === "mjs"
      ? "export default { register }; export { register };"
      : "module.exports = { register }; module.exports.register = register;";
    const plugin = await fixture(t, format, `
function register(context) {
  events.push("object register");
  addTool(context, "object_probe", "object");
}`, exports);
    assert.equal((plugin.imported.default as { register: unknown }).register, plugin.imported.register);
    const registry = new ToolRegistry();
    assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), [plugin.filename]);
    assert.deepEqual(plugin.imported.getEvents(), ["object register"]);
    assert.equal(await toolResult(registry, "object_probe"), "object");
  });
}

test("mjs: distinct named and object-default callbacks keep their existing order", async (t) => {
  const plugin = await fixture(t, "mjs", `
function register(context) { events.push("named"); addTool(context, "named_probe", "named"); }
function objectRegister(context) { events.push("object"); addTool(context, "object_probe", "object"); }`,
  "export { register }; export default { register: objectRegister };");
  const registry = new ToolRegistry();
  assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry), [plugin.filename]);
  assert.deepEqual(plugin.imported.getEvents(), ["named", "object"]);
  assert.deepEqual(registry.list().map((tool) => tool.name), ["named_probe", "object_probe"]);
});

test("mjs: a shared callback executes once for every plugin file", async (t) => {
  const plugin = await fixture(t, "mjs", "function defaultRegister() { events.push(\"register\"); }", functionExports("mjs", true));
  await writeFile(path.join(plugin.workspaceRoot, "reexport.mjs"), `export { default, register } from "./${plugin.filename}";\n`, "utf8");
  assert.deepEqual(await loadPlugins(plugin.workspaceRoot, [plugin.filename, "reexport.mjs"], config, new ToolRegistry()), [plugin.filename, "reexport.mjs"]);
  assert.deepEqual(plugin.imported.getEvents(), ["register", "register"]);
});

test("mjs: updated live aliases still invoke a distinct callback after the default completes", async (t) => {
  const plugin = await fixture(t, "mjs", `
function nextRegister(context) { events.push("next"); addTool(context, "next_probe", "next"); }
let currentRegister = async (context) => {
  events.push("initial");
  addTool(context, "initial_probe", "initial");
  await Promise.resolve();
  currentRegister = nextRegister;
};`, "export { currentRegister as default, currentRegister as register };");
  const registry = new ToolRegistry();
  await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry);
  assert.deepEqual(plugin.imported.getEvents(), ["initial", "next"]);
  assert.equal(await toolResult(registry, "next_probe"), "next");
});

test("mjs: a changed default binding still skips the named callback already invoked", async (t) => {
  const plugin = await fixture(t, "mjs", `
function initialRegister(context) {
  events.push("initial");
  addTool(context, "initial_probe", "initial");
  currentDefault = () => { events.push("replacement default"); };
}
let currentDefault = initialRegister;`, "export { currentDefault as default, initialRegister as register };");
  const registry = new ToolRegistry();
  await loadPlugins(plugin.workspaceRoot, [plugin.filename], config, registry);
  assert.deepEqual(plugin.imported.getEvents(), ["initial"]);
  assert.equal(await toolResult(registry, "initial_probe"), "initial");
});
