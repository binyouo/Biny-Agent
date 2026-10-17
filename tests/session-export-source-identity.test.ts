/** Export identity belongs to the same resolved source as its event bytes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import type { BinySessionBundle } from "../src/session/transfer.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-identity-")));
const previousAgentRoot = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const { attachmentFilePath, attachmentRoot, saveAttachment } = await import("../src/attachments/store.js");
const { createSessionFile, ensureAgentDirs, resolveSessionFile } = await import("../src/session/store.js");
const { sessionExportCommand } = await import("../src/cli/commands/sessionTransfer.js");
after(async () => {
  if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentRoot;
  await fs.rm(root, { recursive: true, force: true });
});

for (const format of ["biny", "claude"] as const) {
  for (const scenario of ["latest-changes", "latest-stable", "explicit-id"] as const) {
    test(`${format} export keeps source identity: ${scenario}`, async (t) => {
      // Unique workspace/file paths keep each real reader cold, including explicit-ID controls.
      const workspace = path.join(root, `${format}-${scenario}`);
      const output = path.join(workspace, "output");
      await fs.mkdir(workspace);
      await fs.mkdir(output);
      await ensureAgentDirs(workspace);
      const aBytes = Buffer.from("A attachment: 中文\0\n");
      const bBytes = Buffer.from("B attachment: different bytes\n");
      const aAttachment = await saveAttachment(workspace, "a.txt", "text/plain", aBytes);
      const bAttachment = await saveAttachment(workspace, "b.txt", "text/plain", bBytes);
      const aEvents: SessionEvent[] = [{
        type: "user_message", content: "Conversation A", attachments: [aAttachment]
      }];
      const bEvents: SessionEvent[] = [{
        type: "user_message", content: "Conversation B", attachments: [bAttachment]
      }];
      const aSource = `${aEvents.map(event => JSON.stringify(event)).join("\n")}\n`;
      const bSource = `${bEvents.map(event => JSON.stringify(event)).join("\n")}\n`;
      const appended = `${JSON.stringify({ type: "assistant_message", content: "B continues" })}\n`;
      const aPath = await createSessionFile(workspace, "source-a", Buffer.from(aSource));
      const bPath = await createSessionFile(workspace, "source-b", Buffer.from(bSource));
      const early = new Date("2020-01-01T00:00:00.000Z");
      const initialLatest = new Date("2020-01-02T00:00:00.000Z");
      const nextLatest = new Date("2020-01-03T00:00:00.000Z");
      await fs.utimes(bPath, early, early);
      await fs.utimes(aPath, initialLatest, initialLatest);
      assert.equal(await resolveSessionFile(workspace, "latest"), aPath);
      const aBefore = await fs.stat(aPath);
      const bBefore = await fs.stat(bPath);
      const advance = scenario !== "latest-stable";
      let readBytes = 0;
      let promotions = 0;
      const open = fs.open.bind(fs);
      const lines: string[] = [];
      const previousCwd = process.cwd();
      try {
        t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const handle = await open(...args);
          if (args[0] !== aPath) return handle;
          let consumed = 0;
          const read = handle.read.bind(handle);
          const close = handle.close.bind(handle);
          // Delegate all real arguments and preserve the FileHandle receiver/return value.
          t.mock.method(handle, "read", (async (...values: Parameters<FileHandle["read"]>) => {
            const result = await read(...values);
            consumed += result.bytesRead;
            readBytes += result.bytesRead;
            return result;
          }) as FileHandle["read"]);
          t.mock.method(handle, "close", async () => {
            await close();
            // Discovery handles only stat; only the completed event reader triggers this.
            if (!advance || consumed === 0 || promotions !== 0) return;
            promotions += 1;
            await fs.appendFile(bPath, appended);
            await fs.utimes(bPath, nextLatest, nextLatest);
          });
          return handle;
        });
        t.mock.method(console, "log", (line: string) => { lines.push(line); });
        process.chdir(output);
        await sessionExportCommand(workspace, scenario === "explicit-id" ? "source-a" : "latest", { format, json: true });
      } finally {
        process.chdir(previousCwd);
        t.mock.restoreAll();
      }

      assert.equal(readBytes, Buffer.byteLength(aSource), "A was read through the real event reader exactly once");
      assert.equal(promotions, advance ? 1 : 0);
      assert.equal(await resolveSessionFile(workspace, "latest"), advance ? bPath : aPath,
        "the controlled append must really change latest when requested");
      assert.equal(await fs.readFile(aPath, "utf8"), aSource);
      assert.equal(await fs.readFile(bPath, "utf8"), bSource + (advance ? appended : ""));
      const aAfter = await fs.stat(aPath);
      const bAfter = await fs.stat(bPath);
      assert.deepEqual([aAfter.dev, aAfter.ino, aAfter.mode, aAfter.mtimeMs],
        [aBefore.dev, aBefore.ino, aBefore.mode, aBefore.mtimeMs], "export preserves A identity, permissions and mtime");
      assert.deepEqual([bAfter.dev, bAfter.ino, bAfter.mode], [bBefore.dev, bBefore.ino, bBefore.mode]);
      assert.equal(bAfter.mtimeMs, advance ? nextLatest.getTime() : bBefore.mtimeMs);
      assert.deepEqual(await fs.readFile(attachmentFilePath(attachmentRoot(workspace), aAttachment.path)!), aBytes);
      assert.deepEqual(await fs.readFile(attachmentFilePath(attachmentRoot(workspace), bAttachment.path)!), bBytes);

      assert.equal(lines.length, 1);
      const result = JSON.parse(lines[0]!) as { file: string; format: string; baseName: string };
      const exported = await fs.readFile(result.file, "utf8");
      // Check content before naming: the baseline race exports A's content under B's identity.
      if (format === "biny") {
        const bundle = JSON.parse(exported) as BinySessionBundle;
        assert.deepEqual(bundle.events, aEvents);
        assert.equal(bundle.manifest.eventCount, aEvents.length);
        assert.equal(bundle.manifest.attachmentCount, 1);
        assert.deepEqual(bundle.manifest.skippedAttachments, []);
        assert.deepEqual(bundle.attachments, [{
          name: aAttachment.name, mimeType: aAttachment.mimeType, sourcePath: aAttachment.path,
          size: aBytes.length, data: aBytes.toString("base64"),
          sha256: createHash("sha256").update(aBytes).digest("hex")
        }]);
        assert.equal(bundle.manifest.sessionId, "source-a", "bundle provenance must identify the source of its events");
      } else {
        // Claude's documented lossy attachment policy is unchanged; assert conversation content.
        const rows = exported.trim().split("\n").map(line => JSON.parse(line) as {
          type: string; message: { role: string; content: string }
        });
        assert.deepEqual(rows, [{ type: "user", message: { role: "user", content: "Conversation A" } }]);
      }
      assert.deepEqual(result, {
        file: path.join(output, `source-a.${format === "biny" ? "json" : "jsonl"}`),
        format, baseName: "source-a"
      });
      assert.deepEqual(await fs.readdir(output), [path.basename(result.file)]);
    });
  }
}
