/** 编辑输入切换的真实文件与 Responses 线协议回归；不进行界面自动验收。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { resolveEditingMode, resolveNativePatchProtocol } from "../src/tools/file/editingMode.js";
import { applyStringEdit } from "../src/tools/file/stringEdit.js";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

assert.equal(resolveEditingMode(true, "openai-structured"), "hashline");
assert.equal(resolveEditingMode(false, "openai-structured"), "patch");
assert.equal(resolveEditingMode(undefined, undefined), "replace");
assert.equal(resolveNativePatchProtocol("responses", "https://api.openai.com/v1", "gpt-5.4", undefined), "openai-structured");
assert.equal(resolveNativePatchProtocol("responses", "https://api.openai.com/v1", "gpt-6-astra", undefined), "openai-structured");
assert.equal(resolveNativePatchProtocol("responses", "https://proxy.example/v1", "gpt-5.4", undefined), undefined);
assert.equal(resolveNativePatchProtocol("responses", "https://proxy.example/v1", "custom", "openai-structured"), "openai-structured");
assert.equal(resolveNativePatchProtocol("chat_completions", "https://api.openai.com/v1", "gpt-5.4", "openai-structured"), undefined);
assert.equal(resolveNativePatchProtocol("responses", "https://api.openai.com/v1", "gpt-5.4", "off"), undefined);
assert.equal(applyStringEdit("one one", "one", "two", true).content, "two two");
assert.throws(() => applyStringEdit("one one", "one", "two"), /matches 2/u);
assert.equal(applyStringEdit("  alpha\r\nbeta\r\n", "alpha\nbeta\n", "next\n").content, "next\n");
assert.throws(() => applyStringEdit("alpha", "missing", "new"), /not found/u);

const root = await mkdtemp(path.join(os.tmpdir(), "biny-editing-modes-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
await ensureAgentDirs(root);
const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access" } });
const recorder = new SessionRecorder(root, "editing-modes");
await recorder.recordAndFlush({ type: "user_message", content: "edit files" });
const workspace = new WorkspaceContext(root, [], 32_768, path.join(root, "missing-global.md"));
const contextModel: AgentModel = { provider: "fixture", modelId: "context-only", async stream() { throw new Error("Workspace refresh must not request a model"); } };
const contextMemory = new ContextMemory(() => contextModel, workspace, undefined, 65_536, 32_768);
const runtime = { workspaceRoot: root, config, recorder, contextMemory, toolRegistry: createToolRegistry({ workspaceRoot: root, ignore: [] }) };
const coordinator = new ToolExecutionCoordinator(runtime, new PermissionManager(config.permission), () => undefined);
try {
  await writeFile(path.join(root, "text.txt"), "alpha\nbeta\n");
  const replaceTools = coordinator.createAgentTools({ mode: "replace" });
  assert.equal(replaceTools.find((tool) => tool.name === "Read")?.executionMode, "parallel");
  assert.equal(replaceTools.find((tool) => tool.name === "Write")?.executionMode, "sequential");
  assert.equal(replaceTools.find((tool) => tool.name === "Edit")?.executionMode, "sequential");
  await writeFile(path.join(root, "parallel-edit.txt"), "left\nright\n");
  let parallelEditRequests = 0;
  const parallelEditModel: AgentModel = {
    provider: "fixture",
    modelId: "parallel-edit",
    async stream() {
      parallelEditRequests += 1;
      return streamEvents(parallelEditRequests === 1
        ? [
            { type: "start" },
            { type: "tool-call", id: "edit-left", name: "Edit", arguments: { path: "parallel-edit.txt", old_string: "left", new_string: "first" } },
            { type: "tool-call", id: "edit-right", name: "Edit", arguments: { path: "parallel-edit.txt", old_string: "right", new_string: "second" } },
            { type: "finish", reason: "tool-calls" }
          ]
        : [{ type: "start" }, { type: "finish", reason: "stop" }]);
    }
  };
  for await (const event of vercelAgentLoopContinue(
    { messages: [{ role: "user", content: "edit both lines" }], tools: replaceTools },
    { model: parallelEditModel, tools: replaceTools, maxSteps: 2 }
  )) {
    if (event.type === "error") throw new Error(event.error);
  }
  assert.equal(parallelEditRequests, 2);
  assert.equal(await readFile(path.join(root, "parallel-edit.txt"), "utf8"), "first\nsecond\n");
  const read = await replaceTools.find((tool) => tool.name === "Read")!.execute("read-plain", { path: "text.txt" });
  assert.equal((read.details as { content: string }).content, "alpha\nbeta");
  const edit = await replaceTools.find((tool) => tool.name === "Edit")!.execute("edit-string", { path: "text.txt", old_string: "alpha", new_string: "gamma" });
  assert.equal(edit.isError, false);
  assert.equal(await readFile(path.join(root, "text.txt"), "utf8"), "gamma\nbeta\n");
  const hashTools = coordinator.createAgentTools({ mode: "hashline" });
  const tagged = await hashTools.find((tool) => tool.name === "Read")!.execute("read-tags", { path: "text.txt" });
  const anchor = (tagged.details as { content: string }).content.split(":")[0]!;
  assert.match(anchor, /^1#[0-9A-F]{8}$/u);
  const hashEdit = await hashTools.find((tool) => tool.name === "Edit")!.execute("edit-tags", { operation: "update", path: "text.txt", edits: [{ op: "replace", pos: anchor, lines: ["delta"] }] });
  assert.equal(hashEdit.isError, false);
  assert.equal(await readFile(path.join(root, "text.txt"), "utf8"), "delta\nbeta\n");

  const patchTools = coordinator.createAgentTools({ mode: "patch" });
  assert.ok(patchTools.some((tool) => tool.providerTool === "openai-apply-patch"));
  assert.equal(patchTools.find((tool) => tool.providerTool === "openai-apply-patch")?.executionMode, "sequential");
  assert.ok(!patchTools.some((tool) => ["Write", "Edit"].includes(tool.name)));
  const restricted = new ToolExecutionCoordinator(runtime, new PermissionManager(config.permission), () => undefined, undefined, new Set(["Write"]));
  assert.deepEqual(restricted.createAgentTools({ mode: "patch" }).map((tool) => tool.name), ["Write"]);

  const bodies: Array<Record<string, unknown>> = [];
  const operations = [
    { type: "create_file", path: "patch.txt", diff: "+first\n" },
    { type: "update_file", path: "patch.txt", diff: "@@\n-missing\n+never\n" },
    { type: "update_file", path: "patch.txt", diff: "@@\n-first\n+second\n" },
    { type: "delete_file", path: "patch.txt" }
  ];
  const provider = createOpenAI({ apiKey: "test-key", baseURL: "https://fixture.invalid/v1", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const index = bodies.length - 1;
    const operation = operations[index];
    const item = operation
      ? { type: "apply_patch_call", id: `ap-${index}`, call_id: `patch-${index}`, status: "completed", operation }
      : { type: "message", id: "msg-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: `resp-${index}`, model: "gpt-5.4", created_at: 1 } },
      { type: "response.output_item.added", output_index: 0, item },
      ...(!operation ? [{ type: "response.output_text.delta", item_id: "msg-final", output_index: 0, content_index: 0, delta: "done" }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp-${index}`, model: "gpt-5.4", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const unusedModel: AgentModel = { provider: "fixture", modelId: "gpt-5.4", async stream() { throw new Error("Must use the native Responses transport"); } };
  let history: AgentMessage[] = [];
  for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content: "create update delete" }], tools: patchTools }, { model: unusedModel, vercelModel: provider.responses("gpt-5.4"), tools: patchTools, maxSteps: 5 })) {
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "turn_end") history = event.messages;
  }
  assert.equal(bodies.length, 5);
  assert.ok((bodies[0]!.tools as Array<{ type: string }>).some((tool) => tool.type === "apply_patch"));
  const outputs = (bodies[4]!.input as Array<{ type: string; status?: string }>).filter((item) => item.type === "apply_patch_call_output");
  assert.deepEqual(outputs.map((output) => output.status), ["completed", "failed", "completed", "completed"]);
  await assert.rejects(readFile(path.join(root, "patch.txt")), { code: "ENOENT" });
  const events = await readSessionEvents(recorder.filePath);
  assert.equal(events.filter((event) => event.type === "tool_execution" && event.tool === "apply_patch" && event.change).length, 3);
  assert.ok(!JSON.stringify(toModelMessages(history, false)).includes('"toolName":"apply_patch"'));

  // The normal routed tool must invalidate the same workspace used by the next turn.
  // Earlier protocol tests intentionally finish before these additional patch calls.
  await mkdir(path.join(root, "src"));
  const contextPath = "src/patch-context.ts";
  const contextQuery = "patch-context.ts";
  const workspacePath = path.join("src", contextQuery);
  const patch = patchTools.find((tool) => tool.name === "apply_patch")!;
  const before = await workspace.prepareTurn(contextQuery);
  assert.equal(before.repoMapCandidates.some((entry) => entry.path === workspacePath), false);
  assert.equal(before.snapshot.context.srcTree.some((entry) => entry.includes(workspacePath)), false);
  const created = await patch.execute("context-create", { callId: "context-create", operation: { type: "create_file", path: contextPath, diff: "+export const createdPatchContext = 1;\n" } });
  assert.equal(created.isError, false);
  const afterCreate = await workspace.prepareTurn(contextQuery);
  assert.ok(afterCreate.snapshot.context.srcTree.some((entry) => entry.includes(workspacePath)));
  assert.ok(afterCreate.repoMapCandidates.find((entry) => entry.path === workspacePath)?.symbols.includes("createdPatchContext"));
  assert.equal(afterCreate.snapshot.revision, before.snapshot.revision + 1);

  const updated = await patch.execute("context-update", { callId: "context-update", operation: { type: "update_file", path: contextPath, diff: "@@\n-export const createdPatchContext = 1;\n+export const updatedPatchContextLonger = 2;\n" } });
  assert.equal(updated.isError, false);
  const afterUpdate = await workspace.prepareTurn(contextQuery);
  const updatedEntry = afterUpdate.repoMapCandidates.find((entry) => entry.path === workspacePath);
  assert.ok(updatedEntry?.symbols.includes("updatedPatchContextLonger"));
  assert.equal(updatedEntry?.symbols.includes("createdPatchContext"), false);
  assert.equal(afterUpdate.snapshot.revision, afterCreate.snapshot.revision + 1);
  const modelContext = await contextMemory.prepareTurn(contextQuery, "system", undefined, [], false);
  assert.match(modelContext.systemPrompt ?? "", /updatedPatchContextLonger/u, "the next prompt receives refreshed RepoMap symbols");

  const warm = await workspace.prepareTurn(contextQuery);
  assert.equal(warm.snapshot, afterUpdate.snapshot, "an unchanged next turn retains the warm snapshot");
  assert.equal(warm.repoMapCandidates.find((entry) => entry.path === workspacePath), updatedEntry);
  const failed = await patch.execute("context-failed", { callId: "context-failed", operation: { type: "update_file", path: contextPath, diff: "@@\n-missingLine\n+neverCommitted\n" } });
  assert.equal(failed.isError, true);
  const afterFailure = await workspace.prepareTurn(contextQuery);
  assert.equal(afterFailure.snapshot, warm.snapshot, "an uncommitted failed patch does not invalidate");
  assert.equal(afterFailure.repoMapCandidates.find((entry) => entry.path === workspacePath), updatedEntry);

  const deleted = await patch.execute("context-delete", { callId: "context-delete", operation: { type: "delete_file", path: contextPath } });
  assert.equal(deleted.isError, false);
  const afterDelete = await workspace.prepareTurn(contextQuery);
  assert.equal(afterDelete.snapshot.context.srcTree.some((entry) => entry.includes(workspacePath)), false);
  assert.equal(afterDelete.repoMapCandidates.some((entry) => entry.path === workspacePath), false);
  assert.equal(afterDelete.snapshot.revision, afterUpdate.snapshot.revision + 1);

  const prepared = await createApplyPatchTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ callId: "cas", operation: { type: "update_file", path: "text.txt", diff: "@@\n-delta\n+changed\n" } });
  assert.ok(!("isError" in prepared));
  await writeFile(path.join(root, "text.txt"), "external\n");
  if (!("isError" in prepared)) await assert.rejects(prepared.execute({ toolCallId: "cas" }), /changed after preparation/u);
  assert.equal(await readFile(path.join(root, "text.txt"), "utf8"), "external\n");
} finally {
  await recorder.flush();
  await rm(root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
}

async function* streamEvents(events: ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const event of events) yield event;
}
console.log("editing modes tests passed");
