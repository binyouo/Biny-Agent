import assert from "node:assert/strict";
import filesystem, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { readSessionEvents } from "../src/session/events.js";

const first = `${JSON.stringify({ type: "user_message", content: "request", messageId: "user-1" })}\n`;
const tail = JSON.stringify({ type: "agent_message", messageId: "answer-1", parentMessageId: "user-1",
  message: { role: "assistant", content: [{ type: "text", text: "irreplaceable final result" }] } });

for (const code of ["ENOSPC", "EIO"]) {
  test(`valid canonical tail survives ${code} during newline repair and a later retry`, async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-tail-io-"));
    await ensureAgentDirs(root);
    const file = sessionFilePath(root, "durable-tail");
    const bytes = first + tail;
    await fs.writeFile(file, bytes);
    const recorder = new SessionRecorder(root, "durable-tail");
    const denied = Object.assign(new Error(`simulated ${code}`), { code });
    const write = context.mock.method(filesystem, "writeSync", () => { throw denied; });
    syncBuiltinESMExports();
    let error: unknown;
    try { recorder.repairTailForAppend(); } catch (caught) { error = caught; }
    finally { write.mock.restore(); syncBuiltinESMExports(); await recorder.close(); }
    try {
      assert.equal(await fs.readFile(file, "utf8"), bytes, "valid canonical tail must not be truncated on an I/O error");
      assert.equal(error, denied, "resume must fail instead of reporting successful recovery");
      const retry = new SessionRecorder(root, "durable-tail");
      try { retry.repairTailForAppend(); retry.repairTailForAppend(); } finally { await retry.close(); }
      assert.equal(await fs.readFile(file, "utf8"), `${bytes}\n`);
      assert.equal((await readSessionEvents(file)).length, 2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

for (const suffix of [tail, '{"type":"agent_message",', ""]) {
  test(`tail repair retains existing valid/incomplete/newline behavior: ${suffix.length}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-tail-normal-"));
    await ensureAgentDirs(root);
    const file = sessionFilePath(root, "tail");
    await fs.writeFile(file, first + suffix);
    const recorder = new SessionRecorder(root, "tail");
    try { recorder.repairTailForAppend(); } finally { await recorder.close(); }
    try {
      assert.equal(await fs.readFile(file, "utf8"), suffix === tail ? `${first}${tail}\n` : first);
      assert.equal((await readSessionEvents(file)).length, suffix === tail ? 2 : 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
