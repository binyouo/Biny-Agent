import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDailyMemoryEntry, DailyMemorySectionConflictError, readDailyMemoryNote, readDailyMemorySection,
  upsertDailyMemorySection, writeDailyActivityNote, writeDailyMemoryNote } from "../src/activity/dailyNotes.js";

const date = "2026-10-30";
const fences = [
  ["backticks", "```md", "```"],
  ["tildes", "~~~md", "~~~~"],
  ["indented", "   ```md", "   ```\t"],
  ["non-closing suffix", "```md", "```text\n## 活动记录\nnot a real section\n```"],
  ["short or different markers", "````md", "```\n~~~\n## 活动记录\nnot a real section\n````"]
] as const;

for (const [name, open, close] of fences) {
  test(`activity refresh ignores fake section in ${name} code`, async () => {
    await withNote(async (root) => {
      const chat = `Example:\n${open}\n## 活动记录\nexample body\n${close}\nChat tail`;
      const original = `# ${date}\n\n## 聊天摘要\n\n${chat}\n\n## 活动记录\n\nOld activity\n\n## 自我反思\n\nKeep reflection`;
      await writeDailyMemoryNote(date, original, { configDir: root });
      assert.equal(readDailyMemorySection(original, "聊天摘要"), chat);
      assert.equal(readDailyMemorySection(original, "活动记录"), "Old activity");
      await writeDailyActivityNote(date, "New activity", { configDir: root });
      const next = await readDailyMemoryNote(date, { configDir: root });
      assert.equal(next, original.replace("Old activity\n\n", "New activity\n"));
      assert.equal(readDailyMemorySection(next!, "聊天摘要"), chat);
      assert.equal(readDailyMemorySection(next!, "活动记录"), "New activity");
      assert.equal(readDailyMemorySection(next!, "自我反思"), "Keep reflection");
    });
  });
}

test("append retains fenced headings, entry idempotence, and the next real section", async () => {
  await withNote(async root => {
    const chat = "Before\n```md\n# Example root\n## Example section\n```\nAfter";
    const original = `# ${date}\n\n## 聊天摘要\n\n${chat}\n\n## 活动记录\n\nKeep activity`;
    await writeDailyMemoryNote(date, original, { configDir: root });
    for (let i = 0; i < 2; i += 1) await appendDailyMemoryEntry(date, "聊天摘要", "entry-1", "New entry", { configDir: root });
    const next = (await readDailyMemoryNote(date, { configDir: root }))!;
    assert.ok(readDailyMemorySection(next, "聊天摘要")?.startsWith(chat));
    assert.equal(next.match(/New entry/gu)?.length, 1);
    assert.equal(readDailyMemorySection(next, "活动记录"), "Keep activity");
  });
});

test("section snapshot comparison includes fenced content and preserves conflict behavior", async () => {
  await withNote(async root => {
    const body = "Before\n~~~\n## Example\n~~~\nAfter";
    await writeDailyMemoryNote(date, `# ${date}\n\n## 每日总结\n\n${body}`, { configDir: root });
    await upsertDailyMemorySection(date, "每日总结", "Replacement", { configDir: root, expectedSectionContent: body });
    await assert.rejects(upsertDailyMemorySection(date, "每日总结", "Stale", { configDir: root, expectedSectionContent: body }), DailyMemorySectionConflictError);
    assert.equal(readDailyMemorySection((await readDailyMemoryNote(date, { configDir: root }))!, "每日总结"), "Replacement");
  });
});

test("plain and legacy activity sections retain existing replacement behavior", async () => {
  await withNote(async root => {
    const original = `# ${date}\n\n## 聊天摘要\n\nKeep chat\n\n## ${date} 工作日记\n\nOld activity`;
    await writeDailyMemoryNote(date, original, { configDir: root });
    await writeDailyActivityNote(date, "New activity", { configDir: root });
    assert.equal(await readDailyMemoryNote(date, { configDir: root }), original.replace(`## ${date} 工作日记`, "## 活动记录").replace("Old activity", "New activity"));
  });
});

async function withNote(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-daily-fences-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const marker of ["```", "~~~"]) {
  test(`unclosed ${marker} prevents invisible section writes without changing the notebook`, async () => {
    await withNote(async root => {
      const original = `# ${date}\n\n## 聊天摘要\n\nExample:\n${marker}md\n## 活动记录\nFake activity`;
      await writeDailyMemoryNote(date, original, { configDir: root });
      assert.equal(readDailyMemorySection(original, "活动记录"), undefined);
      for (let i = 0; i < 2; i += 1) {
        await assert.rejects(writeDailyActivityNote(date, "New activity", { configDir: root }), /code fence is unclosed/u);
        assert.equal(await readDailyMemoryNote(date, { configDir: root }), original);
      }
      await assert.rejects(appendDailyMemoryEntry(date, "自我反思", "entry", "Reflection", { configDir: root }), /code fence is unclosed/u);
      assert.equal(await readDailyMemoryNote(date, { configDir: root }), original);
      // Repairing the user-authored Markdown allows the normal writer to recover.
      const repaired = `${original}\n${marker}`;
      await writeDailyMemoryNote(date, repaired, { configDir: root });
      await writeDailyActivityNote(date, "New activity", { configDir: root });
      assert.equal(await readDailyMemoryNote(date, { configDir: root }), `${repaired}\n\n## 活动记录\n\nNew activity`);
    });
  });
}

test("an existing earlier section can be updated without touching a later unfinished code example", async () => {
  await withNote(async root => {
    const tail = "## 聊天摘要\n\nExample:\n```md\n## Not a section";
    await writeDailyMemoryNote(date, `# ${date}\n\n## 活动记录\n\nOld\n\n${tail}`, { configDir: root });
    await writeDailyActivityNote(date, "New", { configDir: root });
    const next = (await readDailyMemoryNote(date, { configDir: root }))!;
    assert.equal(next, `# ${date}\n\n## 活动记录\n\nNew\n${tail}`);
  });
});

test("appending to an existing unfinished section rejects, while replacing that whole section can recover", async () => {
  await withNote(async root => {
    const original = `# ${date}\n\n## 聊天摘要\n\nExample:\n\`\`\`md\n## Fake section`;
    await writeDailyMemoryNote(date, original, { configDir: root });
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(appendDailyMemoryEntry(date, "聊天摘要", "new-entry", "New entry", { configDir: root }), /code fence is unclosed/u);
      assert.equal(await readDailyMemoryNote(date, { configDir: root }), original);
    }
    await upsertDailyMemorySection(date, "聊天摘要", "Replacement", { configDir: root });
    await appendDailyMemoryEntry(date, "聊天摘要", "new-entry", "New entry", { configDir: root });
    const next = (await readDailyMemoryNote(date, { configDir: root }))!;
    assert.ok(readDailyMemorySection(next, "聊天摘要")?.startsWith("Replacement\n\n"));
    assert.equal(next.match(/New entry/gu)?.length, 1);
  });
});

for (const [name, example] of [
  ["list", "- item\n  ```md\n  code"],
  ["blockquote", "> ```md\n> ## 活动记录\n> fake activity"],
  ["HTML comment", "<!--\n```\n## 活动记录\nfake activity\n-->"],
  ["indented code", "    ```\n    ## 活动记录\n    fake activity"]
]) {
  test(`${name} content cannot hide or impersonate a document section`, async () => {
    await withNote(async root => {
      const prefix = `# ${date}\n\n## 聊天摘要\n\n${example}`;
      const original = `${prefix}\n\n## 活动记录\n\nOld activity`;
      await writeDailyMemoryNote(date, original, { configDir: root });
      assert.equal(readDailyMemorySection(original, "活动记录"), "Old activity");
      await writeDailyActivityNote(date, "New activity", { configDir: root });
      assert.equal(await readDailyMemoryNote(date, { configDir: root }), `${prefix}\n\n## 活动记录\n\nNew activity`);
    });
  });
}
