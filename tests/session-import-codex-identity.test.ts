/** Codex 新导入的文本身份贯通日期、引用与回放，工具事实保持为来源事实。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importSessionFile, exportSessionBundle } from "../src/session/transfer.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { sessionMessageTree } from "../src/session/messageTree.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";
import { LocalReferenceService } from "../src/session/localReferences.js";
import { ensureAgentDirs } from "../src/session/store.js";
const timestamp = "2026-10-03T03:00:00.000Z";
const item = (payload: unknown) => ({ type: "response_item", timestamp, payload });
async function fixture(run: (root: string, workspace: string, source: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-codex-identity-")));
  const workspace = path.join(root, "project");
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = root;
  try { await mkdir(workspace); await ensureAgentDirs(workspace); await run(root, workspace, path.join(workspace, "rollout.jsonl")); }
  finally { await refreshSessionIndex(workspace); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

test("public Codex import persists canonical independent text identity and source tool facts for date/reference/replay", async () => {
  await fixture(async (root, workspace, source) => {
    const lines = [{ type: "session_meta", payload: { id: "source-session" } },
      item({ type: "message", id: "source-user", role: "user", content: [{ type: "input_text", text: "检查项目" }] }),
      item({ type: "function_call", name: "read", call_id: "call-f", arguments: '{"path":"src/a.ts"}' }),
      item({ type: "function_call_output", call_id: "call-f", output: '{"output":"file content"}' }),
      item({ type: "custom_tool_call", name: "edit", call_id: "call-c", input: "*** patch bytes ***" }),
      item({ type: "custom_tool_call_output", call_id: "call-c", output: "patch result" }),
      item({ type: "message", id: "source-assistant", role: "assistant", content: [{ type: "output_text", text: "检查完成" }] })];
    await writeFile(source, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const imported = await importSessionFile(workspace, source);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const nodes = sessionMessageTree(events);
    assert.deepEqual(nodes.map((node) => node.message.role), ["user", "assistant"]);
    assert.equal(nodes[1]?.parentId, nodes[0]?.id);
    assert.equal(new Set(nodes.map((node) => node.slotId)).size, 2);
    assert.ok(nodes.every((node) => node.id !== "source-user" && node.id !== "source-assistant"));
    assert.equal(events.find((event) => event.type === "assistant_message")?.messageId, nodes[1]?.id);
    assert.deepEqual(events.filter((event) => event.type === "tool_call" || event.type === "tool_result").map((event) => event.importSource), [
      { format: "codex", record: 3, toolCallId: "call-f" }, { format: "codex", record: 4, toolCallId: "call-f" },
      { format: "codex", record: 5, toolCallId: "call-c" }, { format: "codex", record: 6, toolCallId: "call-c" }
    ]);
    const replay = replaySessionEvents(events);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(replay.messages.filter((message) => message.role === "toolResult").map((message) => message.details), ["file content", "patch result"]);
    assert.deepEqual(events.find((event) => event.type === "tool_call" && event.tool === "edit")?.args, { input: "*** patch bytes ***" });
    const service = new DateReferenceDetailService(root);
    try {
      const detail = await service.query({ startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "Asia/Shanghai" }, [{ id: "project", path: workspace }]);
      assert.equal(detail.conversations.length, 2);
      const references = new LocalReferenceService({ root, projects: [{ id: "project", name: "Project", path: workspace }] });
      for (const hit of detail.conversations) {
        const ref = await references.referenceForMessage(imported.sessionId, hit.messageId, "project");
        assert.equal((await references.resolve(ref.uri, "project")).content, hit.quote);
      }
    } finally { service.close(); }
    const second = await importSessionFile(workspace, source);
    const secondNodes = sessionMessageTree((await readStoredSessionEvents(workspace, second.sessionId)).events);
    assert.ok(secondNodes.every((node) => nodes.every((first) => first.id !== node.id)));
    await writeFile(source, (await exportSessionBundle(workspace, imported.sessionId)).content);
    const roundtrip = await importSessionFile(workspace, source);
    assert.deepEqual((await readStoredSessionEvents(workspace, roundtrip.sessionId)).events, events);
  });
});

test("duplicate source tool IDs retain every call/result without guessing a winning tool name", async () => {
  await fixture(async (_root, workspace, source) => {
    const lines = [item({ type: "message", role: "user", content: [{ type: "input_text", text: "任务" }] }),
      item({ type: "function_call", call_id: "dup", name: "first", arguments: '{"n":1}' }),
      item({ type: "custom_tool_call", call_id: "dup", name: "second", input: "raw second" }),
      item({ type: "function_call_output", call_id: "dup", output: "result one" }),
      item({ type: "custom_tool_call_output", call_id: "dup", output: "result two" }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "答复" }] })];
    await writeFile(source, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const imported = await importSessionFile(workspace, source);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const results = events.filter((event) => event.type === "tool_result");
    assert.deepEqual(results.map((event) => [event.tool, event.result]), [["tool", "result one"], ["tool", "result two"]]);
    assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => event.tool), ["first", "second"]);
    assert.deepEqual(replaySessionEvents(events).messages.filter((message) => message.role === "toolResult").map((message) => message.details), ["result one", "result two"]);
  });
});
