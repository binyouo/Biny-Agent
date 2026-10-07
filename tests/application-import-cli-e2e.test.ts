import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { readStoredSessionEvents } from "../src/session/events.js";
import { sessionMessageTree } from "../src/session/messageTree.js";

test("real CLI exposes selected ChatGPT import, exact format errors and persistent import history", { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-import-cli-")));
  const workspace = path.join(root, "workspace");
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const cli = path.resolve("dist/cli/index.js");
  const run = async (...args: string[]) => await promisify(execFile)(process.execPath, [cli, ...args], {
    cwd: workspace, env: { ...process.env, BINY_AGENT_DIR: root }, timeout: 30_000, maxBuffer: 1024 * 1024
  });
  try {
    await mkdir(workspace);
    const file = path.join(root, "conversations.json");
    const conversation = (id: string) => ({ id, title: `Conversation ${id}`, current_node: "a", mapping: {
      u: { parent: null, message: { id: "source-u", author: { role: "user" }, create_time: 1_791_337_600,
        content: { content_type: "text", parts: [`question ${id}`] } } },
      a: { parent: "u", message: { id: "source-a", author: { role: "assistant" }, create_time: 1_791_337_601,
        content: { content_type: "text", parts: [`answer ${id}`] } } }
    } });
    await writeFile(file, JSON.stringify([conversation("one"), conversation("two")]));
    const direct = JSON.parse((await run("session", "import", file, "--format", "chatgpt", "--conversation", "two", "--json")).stdout) as { sessionId: string };
    const tree = sessionMessageTree((await readStoredSessionEvents(workspace, direct.sessionId)).events);
    assert.equal(tree.length, 2);
    assert.equal(tree[1]!.parentId, tree[0]!.id);
    await assert.rejects(run("session", "import", file, "--format", "not-a-format"), /invalid/u);
    const preview = JSON.parse((await run("imports", "preview", "chatgpt", "--file", file, "--json")).stdout) as { id: string; items: Array<{ id: string; label: string }> };
    const selected = preview.items.find(item => item.label === "Conversation one")!;
    const result = JSON.parse((await run("imports", "run", preview.id, "--item", selected.id, "--json")).stdout) as { results: Array<{ status: string }> };
    assert.equal(result.results[0]!.status, "imported");
    const duplicate = JSON.parse((await run("imports", "run", preview.id, "--item", selected.id, "--json")).stdout) as { results: Array<{ status: string }> };
    assert.equal(duplicate.results[0]!.status, "skipped");
    const status = JSON.parse((await run("imports", "--json")).stdout) as { history: unknown[]; sync: { hasSelection: boolean } };
    assert.equal(status.history.length, 2);
    assert.equal(status.sync.hasSelection, true);
    assert.match((await run("imports")).stdout, /Sync: disabled/u);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
