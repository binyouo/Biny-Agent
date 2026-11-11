import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentMessage, AgentModel } from "../src/agent/core/types.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import { testModel } from "./helpers/model.js";

await test("extraction selects four conversational messages across tool round trips", async () => {
  const f = await fixture();
  try {
    const messages: AgentMessage[] = [
      { role: "user", content: "OLD_CONVERSATION" },
      { role: "assistant", content: [{ type: "text", text: "Old response." }] },
      { role: "user", content: "My preferred language is Go." },
      { role: "assistant", content: [{ type: "text", text: "I will check." }, { type: "toolCall", id: "one", name: "WebSearch", arguments: { query: "TOOL_ARGUMENT" } }] },
      { role: "toolResult", toolCallId: "one", toolName: "WebSearch", content: [{ type: "text", text: "TOOL_RESULT" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "user", content: "Please keep answers concise." },
      { role: "assistant", content: [{ type: "toolCall", id: "two", name: "Read", arguments: { path: "TOOL_PATH" } }] },
      { role: "toolResult", toolCallId: "two", toolName: "Read", content: [{ type: "text", text: "TOOL_RESULT" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "Confirmed." }] }
    ];
    const before = structuredClone(messages);
    await f.memory.summarizeAndStoreMemories(messages, { sessionId: "thread", turnId: "turn", runId: "run" });
    assert.equal(f.requests[0], "Extract memories from this conversation:\n\nuser: My preferred language is Go.\n\nassistant: I will check.\nFirst answer.\n\nuser: Please keep answers concise.\n\nassistant: Confirmed.");
    assert.deepEqual(messages, before);
  } finally { await f.close(); }
});

for (const response of ["{broken", new Error("dedup model unavailable")]) {
  await test(`automatic writing adds a candidate when duplicate judgment ${response instanceof Error ? "fails" : "is malformed"}`, async () => {
    const f = await fixture();
    try {
      const old = (await f.memory.writeEntry({ content: "User prefers Go." })).entry!;
      f.candidates = [old];
      f.respond = () => { if (response instanceof Error) throw response; return response; };
      const result = await f.memory.writeAutoEntry({ content: "User prefers Rust." }, { requireSemantic: true });
      assert.equal(result.written, true);
      assert.notEqual(result.entry?.id, old.id);
      assert.equal((await f.memory.getEntry(old.id))?.content, "User prefers Go.");
      assert.equal((await f.memory.listMemoryEntries()).total, 2);
    } finally { await f.close(); }
  });
}

await test("automatic duplicate judgment skips the candidate without rewriting the existing fact", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: "User prefers Go." })).entry!;
    f.candidates = [old];
    f.respond = () => JSON.stringify({ isDuplicate: true, duplicateOf: 1 });
    const result = await f.memory.writeAutoEntry({ content: "Go is the user's preferred language." }, { requireSemantic: true });
    assert.equal(result.written, false);
    assert.equal(result.entry?.id, old.id);
    assert.equal((await f.memory.getEntry(old.id))?.content, "User prefers Go.");
    assert.equal((await f.memory.listArchivedEntries()).total, 0);
  } finally { await f.close(); }
});

await test("a correction processes explicit forgetting before adding replacement information", async () => {
  const f = await fixture();
  try {
    const old = (await f.memory.writeEntry({ content: "User prefers Go." })).entry!;
    f.candidates = [old];
    const stages: string[] = [];
    f.respond = async (prompt) => {
      if (prompt.startsWith("Extract memories")) {
        stages.push("extract");
        return JSON.stringify([{ operation: "delete", content: "the Go preference" }, { operation: "add", content: "User now prefers Rust.", durability: "permanent" }]);
      }
      if (prompt.startsWith("The user wants to delete")) { stages.push("delete"); f.candidates = undefined; return "[1]"; }
      stages.push("dedup");
      assert.equal(await f.memory.getEntry(old.id), undefined);
      return '{"isDuplicate":false}';
    };
    const changes = await f.memory.summarizeAndStoreMemories([
      { role: "user", content: "Forget my Go preference. I prefer Rust now." },
      { role: "assistant", content: [{ type: "text", text: "Understood." }] }
    ], { sessionId: "thread", turnId: "turn", runId: "run" });
    assert.equal(stages[0], "extract");
    assert.equal(stages[1], "delete");
    assert.equal(changes.created[0]?.content, "User now prefers Rust.");
    assert.deepEqual(changes.deleted, [{ id: old.id, content: "User prefers Go." }]);
    assert.equal((await f.memory.listMemoryEntries()).entries[0]?.content, "User now prefers Rust.");
  } finally { await f.close(); }
});

await test("temporary cleanup can remove a temporary fact added in the same extraction", async () => {
  const f = await fixture();
  try {
    f.respond = async (prompt) => {
      if (prompt.startsWith("Extract memories")) return JSON.stringify([{ operation: "add", content: "The user was preparing yesterday's interview.", durability: "temporary" }]);
      if (prompt.startsWith("Current date and time:")) return JSON.stringify((await f.memory.listMemoryEntries()).entries.map((entry) => entry.id));
      return '{"isDuplicate":false}';
    };
    const changes = await f.memory.summarizeAndStoreMemories([
      { role: "user", content: "That interview has finished." },
      { role: "assistant", content: [{ type: "text", text: "Understood." }] }
    ], { sessionId: "thread", turnId: "turn", runId: "run" });
    assert.equal(changes.created.length, 1);
    assert.deepEqual(changes.deleted, changes.created);
    assert.equal((await f.memory.listMemoryEntries()).total, 0);
  } finally { await f.close(); }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-conversation-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const state = {
    candidates: undefined as MemoryEntry[] | undefined,
    requests: [] as string[],
    respond: (_prompt: string): string | Promise<string> => '["NO_MEMORY"]'
  };
  const model: AgentModel = testModel({
    provider: "test", modelId: "memory-conversation",
    async stream(context, options) {
      const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      state.requests.push(prompt);
      const text = await state.respond(prompt);
      return (async function* () {
        options?.signal?.throwIfAborted();
        yield { type: "text-delta" as const, text };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  });
  const memory = new LocalMemory(root, () => model, undefined, 5, undefined, undefined, undefined,
    async () => state.candidates ?? (await memory.listMemoryEntries()).entries);
  return Object.assign(state, {
    memory,
    close: async () => {
      memory.close();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
