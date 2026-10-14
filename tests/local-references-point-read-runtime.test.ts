import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { LocalReferenceService } from "../src/session/localReferences.js";

test("point references read only their session across a mixed 256-session project while preserving fresh visibility", { timeout: 30_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reference-operations-")));
  const workspace = path.join(root, "project");
  const originalRead = fs.readFile;
  try {
    await fs.mkdir(workspace);
    const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
    await fs.mkdir(directory, { recursive: true });
    let fixtureBytes = 0;
    for (let index = 0; index < 256; index += 1) {
      const events = Array.from({ length: 16 }, (_, turn) => ({ type: "user_message", messageId: `message-${turn}`, slotId: `slot-${turn}`, content: `session ${index}, turn ${turn}: ${"本地会话正文".repeat(index % 3 === 0 ? 256 : 32)}` }));
      const body = events.map(event => JSON.stringify(event)).join("\n") + "\n";
      fixtureBytes += Buffer.byteLength(body);
      await fs.writeFile(path.join(directory, `thread-${index}.jsonl`), body);
    }
    const service = new LocalReferenceService({ root, projects: [{ id: "project", path: workspace, name: "Project" }] });
    let reads = 0;
    let bytes = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalRead(...args);
      if (String(args[0]).startsWith(directory) && String(args[0]).endsWith(".jsonl")) { reads += 1; bytes += Buffer.byteLength(result); }
      return result;
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    const observations: Array<{ operation: string; reads: number; bytes: number }> = [];
    const reset = () => { reads = 0; bytes = 0; };
    const uri = "biny://thread/thread-255/message/slot-0";
    for (const operation of ["first", "repeat"]) {
      reset();
      assert.match((await service.resolve(uri, "project")).content, /^session 255, turn 0:/);
      observations.push({ operation, reads, bytes });
    }
    const replacement = [{ type: "user_message", messageId: "new", slotId: "slot-0", content: "edited current value" },
      { type: "tool_call", tool: "Read", toolCallId: "call", args: { path: "notes.txt", apiKey: "PRIVATE_FIXTURE_SECRET" } }];
    await fs.writeFile(path.join(directory, "thread-255.jsonl"), replacement.map(event => JSON.stringify(event)).join("\n") + "\n");
    reset();
    assert.equal((await service.resolve(uri, "project")).content, "edited current value");
    observations.push({ operation: "edit", reads, bytes });
    reset();
    const call = await service.resolve("biny://thread/thread-255/tool/call", "project");
    assert.match(call.content, /notes.txt/);
    assert.doesNotMatch(call.content, /PRIVATE_FIXTURE_SECRET/);
    observations.push({ operation: "tool", reads, bytes });
    await assert.rejects(service.resolve(uri, "foreign"), /not available/);
    await fs.rm(path.join(directory, "thread-255.jsonl"));
    reset();
    await assert.rejects(service.resolve(uri, "project"), /not available/);
    observations.push({ operation: "deleted", reads, bytes });
    console.log(JSON.stringify({ pr: 178, sessionFiles: 256, fixtureBytes, observations }));
    assert.deepEqual(observations.map(item => item.reads), [1, 1, 1, 1, 0]);
  } finally { fs.readFile = originalRead; syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
});
