import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

const image = { type: "image" as const, mimeType: "image/png", data: Buffer.alloc(1024 * 1024, 65).toString("base64") };
type Entry = "plugin" | "direct";

// Synthetic MCP tool, real coordinator/scheduler/permissions/recorder. The bytes
// exercise ownership and budget accounting, not PNG decoding or a live desktop.
async function fixture(run?: (context: ToolExecutionContext) => Promise<unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-image-owner-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.diagnostics.enabled = false;
  config.agent.maxConcurrentTools = 4;
  const recorder = new SessionRecorder(root, "tool-image-owner");
  const registry = new ToolRegistry();
  registry.register({
    name: "mcp_image_fixture_observe", description: "Synthetic image observation", risk: "read",
    mcpIdentity: { serverName: "image-fixture", toolName: "observe" },
    parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
    resolveExecution() {
      return { accesses: [], retrySafety: "safe", async execute(context) {
        if (run) return await run(context);
        return { imageReturned: context.onImage?.(image) === true };
      } };
    }
  } as Tool, "mcp");
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), () => undefined);
  const direct = coordinator.createAgentTools().find(tool => tool.name === "mcp_image_fixture_observe");
  assert.ok(direct);
  return { coordinator, recorder,
    call: (entry: Entry, id: string, signal?: AbortSignal) => entry === "plugin"
      ? coordinator.executePluginMcpTool("image-fixture", "observe", {}, id, signal)
      : direct.execute(id, {}, signal),
    async close() { await coordinator.waitForIdle(); await recorder.close(); await rm(root, { recursive: true, force: true }); }
  };
}

await test("plugin observations return exact image bytes and leave capacity for later model observations", async () => {
  const f = await fixture();
  try {
    for (const [index, entry] of (["plugin", "plugin", "plugin", "direct"] as const).entries()) {
      const result = await f.call(entry, `observe-${index}`);
      assert.equal(result.isError, false);
      assert.equal((result.details as { imageReturned: boolean }).imageReturned, true);
      assert.deepEqual(result.content.filter(part => part.type === "image"), [image]);
    }
  } finally { await f.close(); }
});

for (const entry of ["plugin", "direct"] as const) {
  await test(`${entry} failed observations discard images and release capacity`, async () => {
    let fail = true;
    const f = await fixture(async context => {
      const accepted = context.onImage?.(image) === true;
      return fail ? { error: "synthetic failure" } : { imageReturned: accepted };
    });
    try {
      for (let i = 0; i < 3; i++) {
        const result = await f.call(entry, `failed-${i}`);
        assert.equal(result.isError, true);
        assert.equal(result.content.some(part => part.type === "image"), false);
      }
      fail = false;
      const result = await f.call("direct", "after-failure");
      assert.deepEqual(result.content.filter(part => part.type === "image"), [image]);
    } finally { await f.close(); }
  });

  await test(`${entry} persistence rejection releases the undelivered image`, async () => {
    const f = await fixture();
    const original = f.recorder.recordAndFlush.bind(f.recorder);
    try {
      f.recorder.recordAndFlush = async (...args) => {
        if (args[0].type === "tool_result") throw new Error("injected result persistence failure");
        return await original(...args);
      };
      for (let i = 0; i < 3; i++) await assert.rejects(f.call(entry, `rejected-${i}`), /injected result persistence failure/);
      f.recorder.recordAndFlush = original;
      const result = await f.call("direct", "after-rejection");
      assert.deepEqual(result.content.filter(part => part.type === "image"), [image]);
    } finally { f.recorder.recordAndFlush = original; await f.close(); }
  });
}

for (const entry of ["plugin", "direct"] as const) {
  await test(`${entry} cancelled observations discard images and release capacity`, async () => {
    let cancel = true;
    let controller = new AbortController();
    const f = await fixture(async context => {
      const accepted = context.onImage?.(image) === true;
      if (cancel) {
        controller.abort();
        context.signal?.throwIfAborted();
      }
      return { imageReturned: accepted };
    });
    try {
      for (let i = 0; i < 3; i++) {
        controller = new AbortController();
        const result = await f.call(entry, `cancelled-${i}`, controller.signal);
        assert.equal(result.isError, true);
        assert.equal(result.content.some(part => part.type === "image"), false);
      }
      cancel = false;
      for (let i = 0; i < 3; i++) {
        const next = await f.call("direct", `after-cancel-${i}`);
        assert.deepEqual(next.content.filter(part => part.type === "image"), [image]);
      }
    } finally { await f.close(); }
  });
}

await test("concurrent plugin calls retain separate images and respect the existing shared cap", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted = 0;
  let ready!: () => void;
  const allReady = new Promise<void>(resolve => { ready = resolve; });
  const f = await fixture(async context => {
    const ownImage = { ...image, mimeType: context.toolCallId === "a" ? "image/png" : "image/jpeg" };
    const accepted = context.onImage?.(ownImage) === true;
    if (++admitted === 3) ready();
    await gate;
    return { imageReturned: accepted };
  });
  const calls = ["a", "b", "c"].map(id => f.call("plugin", id));
  try {
    await allReady;
    release();
    const results = await Promise.all(calls);
    assert.deepEqual(results.map(result => result.content.filter(part => part.type === "image").length), [1, 1, 0]);
    assert.deepEqual(results.map(result => (result.details as { imageReturned: boolean }).imageReturned), [true, true, false]);
    assert.equal(results[0]?.content.find(part => part.type === "image")?.mimeType, "image/png");
    assert.equal(results[1]?.content.find(part => part.type === "image")?.mimeType, "image/jpeg");
    const next = await f.call("direct", "after-concurrent");
    assert.equal(next.content.filter(part => part.type === "image").length, 1);
  } finally { release(); await Promise.allSettled(calls); await f.close(); }
});
