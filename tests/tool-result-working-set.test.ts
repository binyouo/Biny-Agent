import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("a large model window still bounds retained file output without losing recent or durable evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-result-working-set-"));
  let agent: AgentSession | undefined;
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.context.maxInputTokens = 1_000_000;
    config.context.maxTurnToolResultBytes = 16_384;
    config.context.memory.enabled = false;
    config.context.identity.enabled = false;
    config.activity.enabled = false;
    config.checkpoints.enabled = false;
    config.permission.mode = "full-access";
    const bodies = Array.from({ length: 10 }, (_, i) => `EVIDENCE_${i}:` + String(i).repeat(2_000));
    await Promise.all(bodies.map((body, i) => writeFile(path.join(root, `${i}.txt`), body)));
    const requests: ModelStreamContext[] = [];
    const model: AgentModel = {
      provider: "test", modelId: "working-set",
      async stream(context) {
        requests.push(structuredClone({ ...context, tools: [] }));
        const index = requests.length - 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          if (index < bodies.length) yield { type: "tool-call", id: `read-${index}`, name: "Read", arguments: { path: `${index}.txt` } };
          else yield { type: "text-delta", text: "inspected" };
          yield { type: "finish", reason: index < bodies.length ? "tool-calls" : "stop" };
        })();
      }
    };
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root, "working-set");
    agent = new AgentSession({ workspaceRoot: root, config, model, recorder, toolRegistry: registry,
      permissionManager: new PermissionManager(config.permission) });
    await agent.initialize();
    await agent.runTask("Read the ten supplied files.");
    assert.equal(requests.length, 11);
    const final = requests.at(-1)!.messages.filter(message => message.role === "toolResult");
    assert.equal(final.length, 10, "tool/result pairing survives projection");
    assert.ok(!JSON.stringify(final[0]!.content).includes(bodies[0]!), "old file bodies must leave the request before the million-token window fills");
    assert.ok(JSON.stringify(final.at(-1)!.content).includes(bodies[9]!));
    assert.ok(JSON.stringify(final.at(-2)!.content).includes(bodies[8]!));
    assert.ok(Buffer.byteLength(JSON.stringify(final.map(message => message.content))) <= 16_384);
    const archived = final[0]!.details?.archivePath;
    assert.equal(typeof archived, "string");
    assert.ok((await readToolResultArchive(root, String(archived))).output.includes(bodies[0]!));
    const events = await readSessionEvents(recorder.filePath);
    const first = events.find(event => event.type === "tool_result" && event.toolCallId === "read-0");
    assert.ok(first?.type === "tool_result");
    assert.equal(first.result.content, bodies[0], "history projection must not rewrite durable facts");
  } finally {
    await agent?.close();
    if (!agent) await recorder?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retention preserves parallel current results, media and evidence that could not be archived", async () => {
  const calls = (ids: string[]): AgentMessage => ({ role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "lookup", arguments: { id } })) });
  const quotedArchive = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
  const ownArchive = `.biny/tool-results/tool-result-${"b".repeat(64)}.json`;
  const result = (id: string): AgentMessage => ({ role: "toolResult", toolName: "lookup", toolCallId: id,
    content: [{ type: "text", text: `${id}: Example ${quotedArchive}\n` + "evidence ".repeat(300) }] });
  const messages: AgentMessage[] = [
    { role: "user", content: "inspect" }, calls(["old", "image"]), result("old"),
    { role: "toolResult", toolName: "lookup", toolCallId: "image", content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }] },
    calls(["a", "b", "c"]), result("a"), result("b"), result("c")
  ];
  const before = structuredClone(messages);
  assert.deepEqual(await projectToolResultsForModel(messages, { maxRetainedBytes: 1_024 }), before);
  assert.deepEqual(await projectToolResultsForModel(messages, { maxRetainedBytes: 1_024,
    archiveResult: async () => { throw new Error("disk unavailable"); } }), before);
  const archivedIds: string[] = [];
  const projected = await projectToolResultsForModel(messages, { maxRetainedBytes: 1_024,
    archiveResult: async ({ message }) => {
      archivedIds.push(message.toolCallId);
      return { archivePath: ownArchive, resultBytes: 2_709 };
    } });
  assert.deepEqual(archivedIds, ["old"], "the newest parallel batch and image content cannot be discarded for a byte target");
  assert.equal((projected[2] as { details: { archivePath: string } }).details.archivePath, ownArchive,
    "a quoted archive path cannot stand in for an unknown tool's own evidence");
  assert.deepEqual(projected.slice(3), before.slice(3));
  assert.deepEqual(messages, before);
});
