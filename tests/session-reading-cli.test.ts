import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFile, duplicateSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { updateSessionCatalogMetadata } from "../src/session/catalog.js";

const cli = path.resolve("src/cli/index.ts");

test("session CLI reads pages, discovers titled conversations and totals recorded usage without counting copies twice", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-session-reading-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    await ensureAgentDirs(root);
    const events = [
      { type: "user_message", content: "Only the original question", time: "2026-01-01T00:00:00.000Z" },
      { type: "assistant_message", content: "An answer longer than eighty characters. ".repeat(4), time: "2026-01-01T00:00:01.000Z", usage: {
        operation: "agent", provider: "fixture", model: "fixture", modelAlias: "fixture", inputTokens: 100, outputTokens: 20, totalTokens: 120,
        pricingKnown: true, costUsd: 0.002, time: "2026-01-01T00:00:01.000Z"
      } }
    ];
    await createSessionFile(root, "original", Buffer.from(events.map((event, index) => JSON.stringify({ ...event, runtime: { eventId: `reading-fixture-${index}`, eventSeq: index + 1 } })).join("\n") + "\n"));
    await updateSessionCatalogMetadata(root, "original", { title: "Release checklist" });
    const page = await run(root, ["session", "messages", "original", "--limit", "1", "--json"]);
    assert.equal(page.code, 0, page.stderr);
    assert.equal(JSON.parse(page.stdout).messages[0].content, "Only the original question");
    assert.equal(JSON.parse(page.stdout).nextOffset, 1);
    const full = await run(root, ["session", "messages", "original", "--offset", "1", "--full", "--json"]);
    assert.equal(full.code, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).messages[0].content, events[1]!.content);
    assert.equal(JSON.parse(full.stdout).nextOffset, null);
    const search = await run(root, ["session", "search", "release", "--json"]);
    assert.equal(search.code, 0, search.stderr);
    assert.equal(JSON.parse(search.stdout).items[0].title, "Release checklist");
    const bodySearch = await run(root, ["session", "search", "original question", "--json"]);
    assert.equal(bodySearch.code, 0, bodySearch.stderr);
    assert.equal(JSON.parse(bodySearch.stdout).items[0].id, "original");
    await duplicateSessionFile(root, "original", "copy");
    const usage = await run(root, ["usage", "--json"]);
    assert.equal(usage.code, 0, usage.stderr);
    assert.equal(JSON.parse(usage.stdout).summary.calls, 1);
    assert.equal(JSON.parse(usage.stdout).summary.totalTokens, 120);
    assert.equal(JSON.parse(usage.stdout).summary.costUsd, 0.002);
    const missing = await run(root, ["session", "messages", "missing", "--json"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    const invalid = await run(root, ["session", "messages", "original", "--offset", "-1", "--json"]);
    assert.equal(invalid.code, 1);
    const branch = [
      { type: "user_message", content: "Version question", messageId: "question", slotId: "question" },
      { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "Superseded version" }], stopReason: "stop" }, messageId: "old", parentMessageId: "question", slotId: "answer" },
      { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "Selected version" }], stopReason: "stop" }, messageId: "new", parentMessageId: "question", slotId: "answer" },
      { type: "message_version_selected", slotId: "answer", messageId: "new" }
    ].map(event => ({ ...event, time: "2026-01-02T00:00:00.000Z" }));
    await createSessionFile(root, "versions", Buffer.from(branch.map(event => JSON.stringify(event)).join("\n") + "\n"));
    const versions = await run(root, ["session", "messages", "versions", "--full", "--json"]);
    assert.equal(versions.code, 0, versions.stderr);
    assert.deepEqual(JSON.parse(versions.stdout).messages.map((message: { content: string }) => message.content), ["Version question", "Selected version"]);
    const hiddenSearch = await run(root, ["session", "search", "Superseded version", "--json"]);
    assert.equal(hiddenSearch.code, 0, hiddenSearch.stderr);
    assert.deepEqual(JSON.parse(hiddenSearch.stdout).items, []);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

async function run(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], { cwd, env: process.env, signal: AbortSignal.timeout(20_000) });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}
