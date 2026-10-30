import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { archiveConversationMarkdown, ConversationMarkdownMirror } from "../src/session/markdownArchive.js";

const marker = "<!-- biny:conversation-markdown -->\n";
const line = (content: string): string => JSON.stringify({ type: "user_message", content, time: "2026-10-30T10:00:00Z" }) + "\n";

async function fixture(run: (root: string, source: string, target: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-archive-target-ownership-"));
  try {
    await mkdir(path.join(root, "sessions", "project"), { recursive: true });
    await mkdir(path.join(root, "threads"));
    await run(root, path.join(root, "sessions", "project", "chat.jsonl"), path.join(root, "threads", "chat.md"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const original of ["# Personal notes\n\nKeep my text.\n", "", "# Conversation chat\n\nLegacy unmarked export.\n"]) {
  test(`manual archive preserves unowned target (${original ? original.split("\n")[0] : "empty file"}) and isolates the collision`, async () => {
    await fixture(async (root, source, target) => {
      const raw = line("authoritative conversation");
      await writeFile(source, raw);
      await writeFile(target, original);
      await writeFile(path.join(path.dirname(source), "other.jsonl"), line("independent session"));
      const before = await stat(target);
      const result = await archiveConversationMarkdown(root);
      assert.equal(await readFile(target, "utf8"), original);
      assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
      assert.equal(await readFile(source, "utf8"), raw);
      assert.equal(result.exported, 1);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0]?.sessionId, "chat");
      assert.match(result.failed[0]?.error ?? "", /not a generated conversation mirror/u);
      assert.match(await readFile(path.join(root, "threads", "other.md"), "utf8"), /independent session/u);
      assert.equal((await readdir(path.join(root, "threads"))).some(name => name.endsWith(".tmp")), false);
    });
  });
}

test("automatic mirror start, refresh and close preserve an unmarked target", async () => {
  await fixture(async (root, source, target) => {
    const original = "User-owned note, not an archive.\n";
    await writeFile(source, line("first"));
    await writeFile(target, original);
    const mirror = new ConversationMarkdownMirror(root);
    try {
      await mirror.start();
      assert.equal(await readFile(target, "utf8"), original);
      await appendFile(source, line("second"));
      const refreshed = await mirror.refresh();
      assert.equal(refreshed.failed.length, 1);
      assert.equal(await readFile(target, "utf8"), original);
      await appendFile(source, line("third"));
    } finally { await mirror.close(); }
    assert.equal(await readFile(target, "utf8"), original, "close's final archive also respects ownership");
  });
});

test("generated targets still update and unchanged snapshots remain byte and mtime identical", async () => {
  await fixture(async (root, source, target) => {
    await writeFile(source, line("first"));
    assert.equal((await archiveConversationMarkdown(root)).exported, 1);
    assert.ok((await readFile(target, "utf8")).startsWith(marker));
    await appendFile(source, line("second"));
    assert.equal((await archiveConversationMarkdown(root)).exported, 1);
    const bytes = await readFile(target);
    assert.match(bytes.toString(), /second/u);
    const before = await stat(target);
    const again = await archiveConversationMarkdown(root);
    assert.equal(again.exported, 0);
    assert.deepEqual(again.failed, []);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  });
});

test("empty sources and orphan cleanup do not delete unmarked targets", async () => {
  await fixture(async (root, source, target) => {
    const original = "Unmarked existing note\n";
    await writeFile(source, "");
    await writeFile(target, original);
    const personal = path.join(root, "threads", "personal.md");
    await writeFile(personal, "Personal orphan\n");
    const orphan = path.join(root, "threads", "generated-orphan.md");
    await writeFile(orphan, marker + "Old generated snapshot\n");
    const result = await archiveConversationMarkdown(root);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(await readFile(personal, "utf8"), "Personal orphan\n");
    assert.equal(result.removed, 1);
    assert.deepEqual(result.failed, []);
    await assert.rejects(stat(orphan), { code: "ENOENT" });
    await writeFile(target, marker + "Generated empty-source snapshot\n");
    assert.equal((await archiveConversationMarkdown(root)).removed, 1);
    await assert.rejects(stat(target), { code: "ENOENT" });
  });
});

test("moving the unmarked file away allows normal export without lock leakage", async () => {
  await fixture(async (root, source, target) => {
    await writeFile(source, line("ready to export"));
    const original = "Keep separately\n";
    await writeFile(target, original);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await archiveConversationMarkdown(root)).failed.length, 1);
      assert.equal(await readFile(target, "utf8"), original);
    }
    // Model the user's explicit removal from this reserved output filename.
    await writeFile(path.join(root, "saved-note.md"), original);
    await rm(target);
    const result = await archiveConversationMarkdown(root);
    assert.equal(result.exported, 1);
    assert.deepEqual(result.failed, []);
    assert.ok((await readFile(target, "utf8")).startsWith(marker));
    assert.equal(await readFile(path.join(root, "saved-note.md"), "utf8"), original);
  });
});
