import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService } from "../src/session/localReferences.js";

test("message reference creation reads only its requested session and keeps current visibility", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reference-message-point-")));
  const workspace = path.join(root, "project");
  const originalRead = fs.readFile;
  try {
    await fs.mkdir(workspace);
    const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
    await fs.mkdir(directory, { recursive: true });
    const file = (id: string) => path.join(directory, `${id}.jsonl`);
    const write = async (id: string, events: unknown[]) => fs.writeFile(file(id), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    for (let i = 0; i < 64; i++) await write(`thread-${i}`, [
      { type: "user_message", messageId: "shared", slotId: "slot", content: `thread ${i}` }
    ]);
    const service = new LocalReferenceService({ root, projects: [{ id: "project", path: workspace, name: "Project" }] });
    const reads: string[] = [];
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).startsWith(directory) && String(args[0]).endsWith(".jsonl")) reads.push(String(args[0]));
      return originalRead(...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    const result = await service.referenceForMessage("thread-63", "shared", "project");
    assert.equal(result.content, "thread 63");
    assert.equal(result.uri, "biny://thread/thread-63/message/slot");
    assert.deepEqual(reads, [file("thread-63")]);

    await write("thread-63", [
      { type: "user_message", messageId: "shared", slotId: "slot", content: "old" },
      { type: "user_message", messageId: "new", slotId: "slot", content: "new" },
      { type: "message_version_selected", slotId: "slot", messageId: "new" }
    ]);
    await assert.rejects(service.referenceForMessage("thread-63", "shared", "project"), /not available/);
    assert.equal((await service.referenceForMessage("thread-63", "new", "project")).content, "new");
    reads.length = 0;
    await assert.rejects(service.referenceForMessage("missing", "shared", "project"), /not available/);
    assert.deepEqual(reads, []);
    await assert.rejects(service.referenceForMessage("thread-63", "new", "foreign"));
    await fs.rm(file("thread-63"));
    await assert.rejects(service.referenceForMessage("thread-63", "new", "project"), /not available/);
    assert.equal((await service.allMessages("project")).length, 63);
  } finally {
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
