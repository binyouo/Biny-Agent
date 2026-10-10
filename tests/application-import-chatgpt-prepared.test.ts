import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { projectSessionsDir } from "../src/config/paths.js";
import { ApplicationImportService } from "../src/imports/service.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { readSessionEvents } from "../src/session/events.js";

assert.equal(process.env.BINY_TEST_PROCESS, "1");
const previousAgentDir = process.env.BINY_AGENT_DIR;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-chatgpt-batch-")));
await chmod(root, 0o700);
process.env.BINY_AGENT_DIR = root;
const homeDir = path.join(root, "home");
const workspaceRoot = path.join(root, "workspace");
const stateRoot = path.join(root, "imports");
const agentDir = path.join(root, "agent");
const originalParse = JSON.parse;
let sourceParses = 0;
let raw = "";

try {
  for (const directory of [homeDir, workspaceRoot, stateRoot, agentDir]) {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
  process.env.BINY_AGENT_DIR = agentDir;
  let config = structuredClone(defaultConfig);
  const configStore: AgentConfigStore = {
    load: async () => config,
    save: async (value) => { config = value; }
  };
  const service = new ApplicationImportService({ configStore, homeDir, stateRoot });
  const records = ["first", "second"].map((id) => ({
    id,
    title: id,
    current_node: "user",
    mapping: {
      user: {
        parent: null,
        message: {
          id: `source-${id}`,
          author: { role: "user" },
          content: { content_type: "text", parts: [id] }
        }
      }
    }
  }));
  raw = JSON.stringify(records);
  const sourcePath = path.join(homeDir, "conversations.json");
  await writeFile(sourcePath, raw, { mode: 0o600 });
  await chmod(sourcePath, 0o600);
  // Observe only complete source parsing; keep the real parser/persistence paths intact.
  JSON.parse = ((input: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (input === raw) sourceParses++;
    return originalParse(input, reviver);
  }) as typeof JSON.parse;
  const preview = await service.preview("chatgpt", sourcePath);
  const previewParses = sourceParses;
  assert.equal(preview.items.length, 2);
  const history = await service.run({
    previewId: preview.id,
    itemIds: preview.items.map((item) => item.id),
    workspaceRoot
  });
  const runParses = sourceParses - previewParses;
  JSON.parse = originalParse;
  assert.deepEqual(history.results.map((result) => result.status), ["imported", "imported"]);
  assert.deepEqual(history.results.map((result) => result.id), preview.items.map((item) => item.id));
  assert.equal(new Set(history.results.map((result) => result.sessionId)).size, 2);
  for (const [index, result] of history.results.entries()) {
    assert.ok(result.sessionId);
    assert.notEqual(result.sessionId, records[index]!.id);
    const events = await readSessionEvents(path.join(projectSessionsDir(workspaceRoot), `${result.sessionId}.jsonl`));
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event?.type === "user_message");
    assert.equal(event.content, records[index]!.id);
    assert.equal(event.importSource?.conversationId, records[index]!.id);
  }
  const state = JSON.parse(await readFile(path.join(stateRoot, "state.json"), "utf8")) as {
    receipts: { status: string; sessionId?: string }[];
  };
  assert.deepEqual(state.receipts.map((receipt) => receipt.status), ["imported", "imported"]);
  assert.deepEqual(state.receipts.map((receipt) => receipt.sessionId), history.results.map((result) => result.sessionId));
  assert.equal(await readFile(sourcePath, "utf8"), raw);
  console.log(JSON.stringify({ businessAssertions: "passed", previewParses, runParses }));
  assert.deepEqual({ previewParses, runParses }, { previewParses: 1, runParses: 1 });
} finally {
  JSON.parse = originalParse;
  await refreshSessionIndex(workspaceRoot);
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
