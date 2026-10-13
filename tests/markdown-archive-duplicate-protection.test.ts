/** CI-only real filesystem regression; local review executes only the separate pure pre-scan fixture. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { archiveConversationMarkdown } from "../src/session/markdownArchive.js";

test("all three duplicate sources preserve their existing mirror while unique files export, then recover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-archive-duplicate-"));
  try {
    const directories = ["project-a", "project-b/2025/01", "project-c"];
    for (const directory of directories) await mkdir(path.join(root, "sessions", directory), { recursive: true });
    await mkdir(path.join(root, "threads"));
    const sources = directories.map((directory) => path.join(root, "sessions", directory, "shared.jsonl"));
    const line = (content: string): string =>
      JSON.stringify({ type: "user_message", time: "2026-10-01T00:00:00.000Z", content }) + "\n";
    const originals = sources.map((_, index) => line("duplicate source " + index));
    for (let index = 0; index < sources.length; index++) await writeFile(sources[index]!, originals[index]!);
    const uniqueSource = path.join(root, "sessions", directories[0]!, "unique.jsonl");
    const uniqueBytes = line("independent unique message");
    await writeFile(uniqueSource, uniqueBytes);
    const target = path.join(root, "threads", "shared.md");
    const oldSnapshot = "<!-- biny:conversation-markdown -->\n# Keep existing duplicate snapshot\n";
    await writeFile(target, oldSnapshot);

    const first = await archiveConversationMarkdown(root);
    assert.equal(first.exported, 1);
    assert.equal(first.removed, 0);
    assert.deepEqual(first.failed, sources.map(() => ({
      sessionId: "shared", error: "Duplicate session id; refusing to overwrite another conversation."
    })));
    assert.equal(await readFile(target, "utf8"), oldSnapshot, "first and all later duplicates must not overwrite");
    assert.match(await readFile(path.join(root, "threads", "unique.md"), "utf8"), /independent unique message/u);
    for (let index = 0; index < sources.length; index++) assert.equal(await readFile(sources[index]!, "utf8"), originals[index]);

    await rm(sources[1]!);
    await rm(sources[2]!);
    const recovered = await archiveConversationMarkdown(root);
    assert.deepEqual(recovered.failed, []);
    assert.equal(recovered.exported, 1);
    assert.equal(recovered.removed, 0);
    assert.match(await readFile(target, "utf8"), /duplicate source 0/u);
    assert.doesNotMatch(await readFile(target, "utf8"), /duplicate source [12]/u);
    assert.equal(await readFile(sources[0]!, "utf8"), originals[0]);
    assert.equal(await readFile(uniqueSource, "utf8"), uniqueBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
