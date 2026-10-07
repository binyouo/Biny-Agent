/** 新导入的消息身份贯通 JSONL、父链、日期详情、引用及导出/分叉。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sessionImportCommand } from "../src/cli/commands/sessionTransfer.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { forkSession } from "../src/session/fork.js";
import { LocalReferenceService } from "../src/session/localReferences.js";
import { activeSessionMessageIds, sessionMessageTree } from "../src/session/messageTree.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { exportSessionBundle, exportSessionClaudeCode, importSessionFile } from "../src/session/transfer.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

const timestamp = "2026-10-03T03:00:00Z";
const range = { startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "Asia/Shanghai" };
async function fixture(run: (root: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-import-identity-")));
  const workspace = path.join(root, "project");
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  try { await mkdir(workspace); await ensureAgentDirs(workspace); await run(root, workspace); }
  finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
async function source(workspace: string, lines: unknown[]): Promise<string> {
  const file = path.join(workspace, "source.jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("CLI Claude import creates distinct stable identities for text and array messages, including repeated or missing source IDs", async () => {
  await fixture(async (root, workspace) => {
    const file = await source(workspace, [
      { type: "user", uuid: "same", timestamp, message: { role: "user", content: "first question" } },
      { type: "assistant", uuid: "same", parentUuid: "same", slotId: "same", timestamp,
        message: { role: "assistant", content: "first answer" } },
      { type: "user", parentUuid: "missing-branch", timestamp, message: { role: "user", content: [{ type: "text", text: "second question" }] } },
      { type: "assistant", uuid: "last", parentUuid: "same", timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }
    ]);
    const printed: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value: unknown) => { printed.push(String(value)); };
      await sessionImportCommand(workspace, file, { format: "claude", json: true });
    } finally { console.log = originalLog; }
    const imported = JSON.parse(printed[0]!) as { sessionId: string; filePath: string };
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const nodes = sessionMessageTree(events);
    assert.equal(nodes.length, 4, "all imported text messages are canonical navigable nodes");
    assert.equal(new Set(nodes.map((node) => node.id)).size, 4);
    assert.equal(new Set(nodes.map((node) => node.slotId)).size, 4, "user and assistant never share a slot");
    for (const [index, node] of nodes.entries()) {
      assert.match(node.id, /^msg_[a-f0-9]{24}$/u);
      assert.equal(node.slotId, node.id);
      assert.equal(node.parentId, nodes[index - 1]?.id);
    }
    assert.equal(activeSessionMessageIds(events).size, 4);
    const firstRead = await readFile(imported.filePath, "utf8");
    assert.deepEqual(sessionMessageTree((await readStoredSessionEvents(workspace, imported.sessionId)).events), nodes);
    const sources = events.filter((event) => event.type === "user_message" || event.type === "agent_message")
      .map((event) => event.importSource);
    assert.deepEqual(sources, [
      { format: "claude", record: 1, messageId: "same" },
      { format: "claude", record: 2, messageId: "same", parentMessageId: "same" },
      { format: "claude", record: 3, parentMessageId: "missing-branch" },
      { format: "claude", record: 4, messageId: "last", parentMessageId: "same" }
    ]);
    const flat = events.filter((event) => event.type === "assistant_message");
    assert.deepEqual(flat.map((event) => [event.messageId, event.slotId]), nodes.filter((node) => node.message.role === "assistant")
      .map((node) => [node.id, node.slotId]));
    assert.deepEqual(replaySessionEvents(events).messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    const timeline = buildSessionTimeline(events, []);
    assert.equal(timeline.length, 2);
    assert.deepEqual(timeline.map((turn) => turn.assistant), ["first answer", "second answer"]);
    const detailService = new DateReferenceDetailService(root);
    try {
      const detail = await detailService.query(range, [{ id: "project", path: workspace }]);
      assert.equal(detail.conversations.length, 4, "date detail must retain exactly one hit per imported message");
      const references = new LocalReferenceService({ root, projects: [{ id: "project", name: "Project", path: workspace }] });
      for (const hit of detail.conversations) {
        const ref = await references.referenceForMessage(hit.sessionId, hit.messageId, "project");
        assert.equal((await references.resolve(ref.uri, "project")).content, hit.quote);
      }
      await assert.rejects(references.resolve(`biny://thread/${imported.sessionId}/message/same`, "project"), /not available/u);
    } finally { detailService.close(); }
    assert.equal(await readFile(imported.filePath, "utf8"), firstRead, "query never repairs the stored log");
    const fork = await forkSession(workspace, imported.sessionId);
    assert.deepEqual(sessionMessageTree((await readStoredSessionEvents(workspace, fork.sessionId)).events), nodes);
    const bundle = await exportSessionBundle(workspace, imported.sessionId);
    const bundleFile = path.join(workspace, "bundle.json");
    await writeFile(bundleFile, bundle.content);
    const rebundled = await importSessionFile(workspace, bundleFile);
    assert.deepEqual((await readStoredSessionEvents(workspace, rebundled.sessionId)).events, events);
    const secondImport = await importSessionFile(workspace, file);
    const secondIds = sessionMessageTree((await readStoredSessionEvents(workspace, secondImport.sessionId)).events).map((node) => node.id);
    assert.ok(secondIds.every((id) => !nodes.some((node) => node.id === id)), "reimport allocates a new message namespace");
    const exported = await exportSessionClaudeCode(workspace, imported.sessionId);
    const roundtripFile = path.join(workspace, "roundtrip.jsonl");
    await writeFile(roundtripFile, exported.content);
    const roundtrip = await importSessionFile(workspace, roundtripFile);
    assert.deepEqual(replaySessionEvents((await readStoredSessionEvents(workspace, roundtrip.sessionId)).events).messages,
      replaySessionEvents(events).messages);
  });
});

test("mixed assistant tool blocks and user result blocks have independent parent-linked identities without guessing missing call IDs", async () => {
  await fixture(async (root, workspace) => {
    const file = await source(workspace, [
      { type: "user", uuid: "u", timestamp, message: { role: "user", content: "read two files" } },
      { type: "assistant", uuid: "a", timestamp, message: { role: "assistant", content: [
        { type: "thinking", thinking: "inspect both" }, { type: "text", text: "reading" },
        { type: "tool_use", id: "call-1", name: "Read", input: { path: "one" } },
        { type: "tool_use", id: "call-2", name: "Read", input: { path: "two" } }
      ] } },
      { type: "user", uuid: "results", timestamp, message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "call-2", content: "two" },
        { type: "tool_result", tool_use_id: "call-1", content: "one", is_error: true },
        { type: "text", text: "continue" }
      ] } },
      { type: "assistant", timestamp, message: { role: "assistant", content: "done" } }
    ]);
    const imported = await importSessionFile(workspace, file);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const nodes = sessionMessageTree(events);
    assert.deepEqual(nodes.map((node) => node.message.role), ["user", "assistant", "toolResult", "toolResult", "user", "assistant"]);
    for (const [index, node] of nodes.entries()) assert.equal(node.parentId, nodes[index - 1]?.id);
    assert.equal(new Set(nodes.map((node) => node.slotId)).size, nodes.length);
    const replay = replaySessionEvents(events);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(replay.messages.filter((message) => message.role === "toolResult")
      .map((message) => [message.toolCallId, message.toolName, message.isError]), [["call-2", "Read", undefined], ["call-1", "Read", true]]);
    assert.equal(replay.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.filter((part) => part.type === "toolCall")).length, 2);
    const timeline = buildSessionTimeline(events, []);
    assert.equal(timeline.flatMap((turn) => turn.steps.filter((step) => step.kind === "tool")).length, 2,
      "canonical and flat tool facts display each invocation once");
    assert.deepEqual(timeline.flatMap((turn) => turn.steps.filter((step) => step.kind === "assistant").map((step) => step.content)),
      ["reading", "done"]);
    const references = new LocalReferenceService({ root, projects: [{ id: "project", name: "Project", path: workspace }] });
    assert.equal((await references.resolve(`biny://thread/${imported.sessionId}/tool/call-1`, "project")).kind, "tool-call");
    const detailService = new DateReferenceDetailService(root);
    try { assert.equal((await detailService.query(range, [{ id: "project", path: workspace }])).conversations.length, 4); }
    finally { detailService.close(); }
    const unknownFile = await source(workspace, [
      { type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "known", name: "tool", input: {} }] } },
      { type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", content: "unknown origin" }] } }
    ]);
    const unknown = await importSessionFile(workspace, unknownFile);
    const unknownEvents = (await readStoredSessionEvents(workspace, unknown.sessionId)).events;
    assert.deepEqual(unknownEvents.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), [undefined]);
    assert.equal(sessionMessageTree(unknownEvents).filter((node) => node.message.role === "toolResult").length, 0,
      "missing call identity never creates a fabricated association");
    const unknownResult = replaySessionEvents(unknownEvents).messages.find((message) => message.role === "toolResult" && message.details === "unknown origin");
    assert.equal(unknownResult?.role === "toolResult" && unknownResult.toolCallId, "",
      "the generic tool name cannot associate an ID-less result with the known invocation");
  });
});


test("old identity-free logs remain untouched and shared user/assistant slots never redirect a user reference", async () => {
  await fixture(async (root, workspace) => {
    const legacy = [
      { type: "user_message", content: "legacy question", time: timestamp },
      { type: "assistant_message", content: "legacy answer", time: timestamp }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const legacyPath = await createSessionFile(workspace, "legacy-import", Buffer.from(legacy));
    const mixed = [
      { type: "user_message", messageId: "user", slotId: "shared", content: "original question", time: timestamp },
      { type: "agent_message", messageId: "answer", parentMessageId: "user", slotId: "shared", time: timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "answer must not replace question reference" }] } },
      { type: "assistant_message", messageId: "answer", parentMessageId: "user", slotId: "shared",
        content: "answer must not replace question reference", time: timestamp }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const mixedPath = await createSessionFile(workspace, "mixed-slot", Buffer.from(mixed));
    const references = new LocalReferenceService({ root, projects: [{ id: "project", name: "Project", path: workspace }] });
    await assert.rejects(references.resolve("biny://thread/mixed-slot/message/shared", "project"), /not available/u);
    await assert.rejects(references.referenceForMessage("mixed-slot", "answer", "project"), /not available/u);
    const service = new DateReferenceDetailService(root);
    try {
      const detail = await service.query(range, [{ id: "project", path: workspace }]);
      assert.equal(detail.conversations.some((hit) => hit.sessionId === "legacy-import"), false);
    } finally { service.close(); }
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
    assert.equal(await readFile(mixedPath, "utf8"), mixed);
    const file = await source(workspace, [
      { type: "user", uuid: "", timestamp, message: { role: "user", content: "empty source identity" } },
      { type: "assistant", uuid: 27, parentUuid: {}, timestamp, message: { role: "assistant", content: "invalid source identity" } }
    ]);
    const imported = await importSessionFile(workspace, file);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    assert.equal(sessionMessageTree(events).length, 2);
    assert.deepEqual(events.filter((event) => event.type === "user_message" || event.type === "agent_message")
      .map((event) => event.importSource),
      [{ format: "claude", record: 1 }, { format: "claude", record: 2 }]);
  });
});

test("repeated invocation or result IDs retain every source fact without inventing canonical links", async () => {
  await fixture(async (_root, workspace) => {
    for (const lines of [
      [
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "reused", name: "Read", input: { path: "first" } }] } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "reused", name: "Write", input: { path: "second" } }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "reused", content: "ambiguous result" }] } }
      ],
      [
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: {} }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "first result" }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "different result" }] } }
      ]
    ]) {
      const file = await source(workspace, lines);
      const imported = await importSessionFile(workspace, file);
      const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
      const expectedCalls = lines.flatMap((line) => line.message.content.filter((block) => block.type === "tool_use"));
      const expectedResults = lines.flatMap((line) => line.message.content.filter((block) => block.type === "tool_result"));
      assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => [event.toolCallId, event.tool, event.args]),
        expectedCalls.map((block) => ["id" in block ? block.id : undefined, "name" in block ? block.name : undefined,
          "input" in block ? block.input : undefined]));
      assert.deepEqual(events.filter((event) => event.type === "tool_result").map((event) => [event.toolCallId, event.result]),
        expectedResults.map((block) => ["tool_use_id" in block ? block.tool_use_id : undefined, "content" in block ? block.content : undefined]));
      assert.equal(events.filter((event) => event.type === "agent_message").length, 0,
        "ambiguous call and result IDs cannot become canonical associations");
      const replay = replaySessionEvents(events);
      const sourceResults = replay.messages.filter((message) => message.role === "toolResult" && typeof message.details === "string");
      assert.deepEqual(sourceResults.map((message) => message.details),
        expectedResults.map((block) => "content" in block ? block.content : undefined));
      assert.equal(replay.messages.filter((message) => message.role === "assistant")
        .flatMap((message) => message.content.filter((part) => part.type === "toolCall")).length, expectedCalls.length,
      "reused source IDs cannot remove a second invocation");
    }
  });
});

test("ignored source records cannot suppress a real unique canonical tool identity", async () => {
  await fixture(async (_root, workspace) => {
    const file = await source(workspace, [
      { type: "summary", message: { role: "assistant", content: [{ type: "tool_use", id: "unique", name: "Ignored", input: {} }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "unique", name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unique", content: "actual result" }] } }
    ]);
    const imported = await importSessionFile(workspace, file);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    assert.deepEqual(sessionMessageTree(events).map((node) => node.message.role), ["assistant", "toolResult"]);
    const replay = replaySessionEvents(events);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(replay.messages.filter((message) => message.role === "toolResult")
      .map((message) => [message.toolCallId, message.toolName, message.details]), [["unique", "Read", "actual result"]]);
  });
});
