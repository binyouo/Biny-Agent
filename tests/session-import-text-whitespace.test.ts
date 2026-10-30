import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { claudeLinesToBinyEvents } from "../src/session/import/claude.js";
import { codexLinesToBinyEvents } from "../src/session/import/codex.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { importSessionFile, exportSessionBundle } from "../src/session/transfer.js";
import { readStoredSessionEvents } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";

function imported(format: "claude" | "codex", role: "user" | "assistant", texts: string[]): SessionEvent[] {
  return format === "claude"
    ? claudeLinesToBinyEvents([{ type: role, message: { role, content: texts.map(text => ({ type: "text", text })) } }])
    : codexLinesToBinyEvents([{ type: "response_item", payload: { type: "message", role,
      content: texts.map(text => ({ type: role === "user" ? "input_text" : "output_text", text })) } }]);
}
function visible(events: SessionEvent[], role: "user" | "assistant"): string {
  const event = events.find(event => event.type === (role === "user" ? "user_message" : "assistant_message"));
  assert.ok(event && (event.type === "user_message" || event.type === "assistant_message"));
  return event.content;
}
const parser = unified().use(remarkParse);
for (const format of ["claude", "codex"] as const) {
  for (const role of ["user", "assistant"] as const) {
    test(`${format} ${role}: imported indented code retains Markdown semantics and exact text`, () => {
      const text = "    const answer = 42;\n    console.log(answer);\n";
      const events = imported(format, role, [text]);
      assert.equal(visible(events, role), text);
      assert.deepEqual(parser.parse(visible(events, role)), parser.parse(text));
      assert.equal(parser.parse(visible(events, role)).children[0]?.type, "code");
      if (role === "assistant") {
        const canonical = events.find(event => event.type === "agent_message");
        assert.ok(canonical?.type === "agent_message" && canonical.message.role === "assistant");
        assert.deepEqual(canonical.message.content, [{ type: "text", text }]);
      }
    });
    test(`${format} ${role}: preserves boundary whitespace, CRLF and existing block separator`, () => {
      const texts = ["\n\tfirst\r\n", "中文 🐈  \n\n"];
      assert.equal(visible(imported(format, role, texts), role), texts.join("\n"));
      assert.deepEqual(imported(format, role, [" \t\r\n", "  "]), []);
    });
  }
}

test("Claude string content and equivalent text blocks preserve the same text", () => {
  for (const role of ["user", "assistant"] as const) {
    const text = "    code\n\n";
    const events = claudeLinesToBinyEvents([{ type: role, message: { role, content: text } }]);
    assert.equal(visible(events, role), text);
    assert.equal(visible(imported("claude", role, [text]), role), text);
  }
});

test("Claude reasoning-only messages still discard a whitespace-only public body", () => {
  const events = claudeLinesToBinyEvents([{ type: "assistant", message: { role: "assistant", content: [
    { type: "thinking", thinking: "reasoning" }, { type: "text", text: " \n\t" }
  ] } }]);
  assert.equal(visible(events, "assistant"), "");
  const canonical = events.find(event => event.type === "agent_message");
  assert.ok(canonical?.type === "agent_message");
  assert.deepEqual(canonical.message.content, [{ type: "reasoning", text: "reasoning" }]);
});

for (const format of ["claude", "codex"] as const) {
  test(`${format}: real import, persisted replay and bundle export retain source text`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-import-text-"));
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "state");
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      await ensureAgentDirs(workspace);
      const text = "    const answer = 42;\r\n    console.log(answer);\r\n\r\n";
      const lines = ["user", "assistant"].map(role => format === "claude"
        ? { type: role, message: { role, content: [{ type: "text", text }] } }
        : { type: "response_item", payload: { type: "message", role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
      const source = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
      const sourcePath = path.join(root, format + ".jsonl");
      await writeFile(sourcePath, source);
      const result = await importSessionFile(workspace, sourcePath, { format });
      const events = (await readStoredSessionEvents(workspace, result.sessionId)).events;
      assert.equal(visible(events, "user"), text);
      assert.equal(visible(events, "assistant"), text);
      const replay = replaySessionEvents(events);
      assert.equal(replay.messages.length, 2);
      assert.equal(replay.messages[0]!.content, text);
      assert.deepEqual(replay.messages[1]!.content, [{ type: "text", text }]);
      const bundle = JSON.parse((await exportSessionBundle(workspace, result.sessionId)).content) as { events: SessionEvent[] };
      assert.equal(visible(bundle.events, "user"), text);
      assert.equal(visible(bundle.events, "assistant"), text);
      assert.equal(await readFile(sourcePath, "utf8"), source);
    } finally {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
