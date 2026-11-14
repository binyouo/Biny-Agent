import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ToolRegistry, type RegisteredTool } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

const makeTool = (name: string): Tool => ({
  name, description: "fixture", parameters: { type: "object", properties: {} }, schema: z.object({}),
  resolveExecution: () => ({ isError: true, result: null, errorMessage: "Discovery fixture cannot execute." })
});

test("registration membership matches list identity across changes and registries", () => {
  const registry = new ToolRegistry();
  const other = new ToolRegistry();
  const tools = [makeTool("one"), makeTool("two")];
  const observed: RegisteredTool[] = [];
  const check = () => {
    for (const entry of observed) assert.equal(registry.hasRegistration(entry), registry.listEntries().includes(entry));
  };
  for (const tool of tools) { registry.register(tool, "mcp"); observed.push(...registry.listEntries()); check(); }
  other.register(tools[0], "mcp"); observed.push(...other.listEntries()); check();
  assert.throws(() => registry.register(tools[0], "mcp"), /already registered/u); check();
  tools[0].name = "renamed"; check();
  assert.equal(registry.unregister("renamed"), false); check();
  assert.equal(registry.unregister("one"), true); check();
  registry.register(tools[0], "mcp"); observed.push(...registry.listEntries()); check();
  assert.equal(registry.unregister("renamed"), true); check();
  tools[0].name = "one";
  registry.register(tools[0], "mcp"); observed.push(...registry.listEntries()); check();
  for (const name of ["one", "two", "missing"]) { registry.unregister(name); check(); }
});

test("Code Mode discovery does not copy the full registry per candidate", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { removeTestRoot } = await import("./helpers/memoryOwnerCleanup.js");
  const { ToolExecutionCoordinator } = await import("../src/agent/toolExecutionCoordinator.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { PermissionManager } = await import("../src/permission/PermissionManager.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { ensureAgentDirs } = await import("../src/session/store.js");
  const root = await mkdtemp(join(tmpdir(), "biny-registry-identity-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = join(root, "agent");
  let recorder: InstanceType<typeof SessionRecorder> | undefined;
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.context.memory.enabled = false;
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    for (let i = 0; i < 100; i++) registry.register({ ...makeTool(`mcp__identity__tool${i}`), exposure: "deferred" }, "mcp");
    recorder = new SessionRecorder(root, "identity");
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    const listEntries = registry.listEntries.bind(registry);
    let copies = 0;
    registry.listEntries = () => { copies++; return listEntries(); };
    const result = await coordinator.createCodeModeTool().execute("discover", { description: "Inspect a tool", code: 'return await describeTool("mcp__identity__tool0");' });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.match(JSON.stringify(result.details), /mcp__identity__tool0/u);
    assert.ok(copies < 20, `Discovery copied the full registry ${copies} times`);
  } finally {
    await recorder?.flush();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
