import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-pagination-coordinator-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const cursor = Buffer.from(JSON.stringify({ page: 2, record: "fixture-page" })).toString("base64url");
let authority: RuntimeEventAuthority | undefined;
let capabilities: CapabilityStore | undefined;
try {
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  capabilities = await CapabilityStore.open(root, authority);
  for (const ledger of [false, true]) {
    for (const script of [false, true]) {
      const config = structuredClone(defaultConfig);
      config.permission.mode = "full-access";
      const registry = new ToolRegistry();
      registry.registerMcpTool(fixtureTool());
      const recorder = new SessionRecorder(root, `pagination-${String(ledger)}-${String(script)}`);
      const coordinator: ToolExecutionCoordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
        capabilities: ledger ? capabilities : undefined }, new PermissionManager(config.permission), () => undefined);
      try {
        const tool = coordinator.createAgentTools(undefined, { script }).find((entry) => entry.name === "fixture_list");
        assert.ok(tool);
        assert.ok(tool.parameters.type === "object");
        assert.ok(tool.outputSchema?.type === "object");
        assert.deepEqual(tool.parameters.properties?.pageToken, { type: "string" });
        assert.deepEqual(tool.outputSchema.properties?.nextPageToken, { type: "string" });
        const first = await tool.execute("first", {});
        const firstText = first.content.find((part) => part.type === "text");
        assert.ok(firstText?.type === "text");
        const firstResult = JSON.parse(firstText.text);
        const page = script ? firstResult.structuredContent : firstResult;
        assert.equal(page.nextPageToken, cursor, "the coordinator's second serializer preserves the MCP continuation");
        assert.deepEqual(page.items, [{ id: "first", body: "first page body" }]);
        assert.equal(page.apiKey, "[redacted]");
        const crashReplay = replaySessionEvents(await readSessionEvents(recorder.filePath), { sessionId: recorder.sessionId });
        const restored = crashReplay.messages.find((message) => message.role === "toolResult" && message.toolCallId === "first");
        assert.ok(restored?.role === "toolResult");
        const restoredText = restored.content.find((part) => part.type === "text");
        assert.ok(restoredText?.type === "text");
        const restoredPage = JSON.parse(restoredText.text);
        assert.equal((script ? restoredPage.structuredContent : restoredPage).nextPageToken, cursor, "captured MCP source reaches Recorder before canonical agent_message persistence");
        const second = await tool.execute("second", { pageToken: page.nextPageToken });
        assert.equal(second.isError, false);
        const secondText = second.content.find((part) => part.type === "text");
        assert.ok(secondText?.type === "text");
        const secondResult = JSON.parse(secondText.text);
        assert.deepEqual((script ? secondResult.structuredContent : secondResult).items, [{ id: "second", body: "second page body" }]);
      } finally {
        await coordinator.waitForIdle();
        await recorder.close();
      }
    }
  }

  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.context.maxTurnToolResultBytes = 1;
  const registry = new ToolRegistry();
  registry.registerMcpTool(fixtureTool());
  const recorder = new SessionRecorder(root, "pagination-archive");
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities }, new PermissionManager(config.permission), () => undefined);
  try {
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "fixture_list");
    assert.ok(tool);
    const first = await tool.execute("archived", {});
    const firstText = first.content.find((part) => part.type === "text");
    assert.ok(firstText?.type === "text");
    const envelope = JSON.parse(firstText.text);
    assert.equal(envelope.archived, true);
    const archive = await readToolResultArchive(root, envelope.archivePath);
    const archivedPage = JSON.parse(archive.output);
    assert.equal(archivedPage.nextPageToken, cursor, "budget archiving uses the same MCP response context");
    assert.equal(archivedPage.apiKey, "[redacted]");
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
  }
  console.log("MCP pagination coordinator tests passed (with/without ledger, direct/script envelopes, schema/body, budget archive)");
} finally {
  capabilities?.close();
  authority?.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}

function fixtureTool(): Tool<{ pageToken?: string }, unknown> {
  return {
    name: "fixture_list", description: "List synthetic fixture pages.", risk: "read", exposure: "direct",
    parameters: { type: "object", properties: { pageToken: { type: "string" } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { nextPageToken: { type: "string" } } },
    schema: z.object({ pageToken: z.string().optional() }),
    resolveExecution(args) {
      return {
        approvalRule: "fixture_list", accesses: ToolAccesses.none(),
        async execute(context) {
          context.onDispatched?.();
          if (args.pageToken !== undefined) assert.equal(args.pageToken, cursor, "the second page receives the original cursor");
          const page = args.pageToken === undefined
            ? { items: [{ id: "first", body: "first page body" }], nextPageToken: cursor, apiKey: "[redacted]" }
            : { items: [{ id: "second", body: "second page body" }] };
          return context.mcpResultMode === "envelope" ? { content: [{ type: "text", text: "fixture page" }], structuredContent: page } : page;
        }
      };
    }
  };
}
