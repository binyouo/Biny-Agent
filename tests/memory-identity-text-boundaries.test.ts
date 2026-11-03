import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeIdentityContent, maxIdentityDocumentChars } from "../src/agent/context/identityFormat.js";
import { IdentityStorage } from "../src/agent/context/identityStorage.js";
import { sanitizeMemoryEntryInput, maxMemoryContentChars } from "../src/agent/context/memoryFormat.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

function examples(limit: number) {
  return [
    { name: "ASCII exact", input: "a".repeat(limit), expected: "a".repeat(limit) },
    { name: "ASCII over", input: "a".repeat(limit) + "tail", expected: "a".repeat(limit) },
    { name: "BMP exact", input: "字".repeat(limit), expected: "字".repeat(limit) },
    { name: "BMP over", input: "字".repeat(limit) + "尾", expected: "字".repeat(limit) },
    { name: "emoji exact", input: "a".repeat(limit - 2) + "😀", expected: "a".repeat(limit - 2) + "😀" },
    { name: "emoji crosses limit", input: "a".repeat(limit - 1) + "😀", expected: "a".repeat(limit - 1) },
    { name: "emoji fits, suffix exceeds", input: "字".repeat(limit - 2) + "😀tail", expected: "字".repeat(limit - 2) + "😀" },
    { name: "emoji starts after limit", input: "a".repeat(limit) + "😀", expected: "a".repeat(limit) },
    { name: "supplementary Han crosses limit", input: "字".repeat(limit - 1) + "𠮷", expected: "字".repeat(limit - 1) },
    { name: "trim precedes truncation", input: " \t" + "字".repeat(limit - 1) + "😀 \n", expected: "字".repeat(limit - 1) }
  ];
}

for (const domain of ["identity", "memory"] as const) {
  const limit = domain === "identity" ? maxIdentityDocumentChars.user : maxMemoryContentChars;
  const normalize = domain === "identity" ? (value: string) => normalizeIdentityContent(value, "user") : (value: string) => sanitizeMemoryEntryInput({ content: value }).content;
  for (const example of examples(limit)) test(`${domain}: ${example.name}`, () => {
    const actual = normalize(example.input);
    assert.equal(actual, example.expected);
    assert.ok(actual.length <= limit, "the UTF-16 budget must not grow");
    assert.equal(Buffer.from(actual, "utf8").toString("utf8"), actual);
  });
  test(`${domain}: existing unpaired surrogates retain previous normalization behavior`, () => {
    for (const invalid of ["\ud83d", "\ude00"]) {
      assert.equal(normalize("before" + invalid + "after"), "before" + invalid + "after");
      assert.equal(normalize("a".repeat(limit - 1) + invalid + "X"), "a".repeat(limit - 1) + invalid);
    }
  });
}

test("USER.md, history, returned overview and a new reader agree at Unicode boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-identity-boundary-"));
  try {
    const storage = new IdentityStorage({ configDir: root });
    let revision = 0;
    for (const example of examples(maxIdentityDocumentChars.user)) {
      const result = await storage.saveDocument("user", example.input, revision);
      revision += 1;
      assert.equal(result.revision, revision);
      assert.equal(result.documents.user?.content, example.expected, example.name);
      assert.equal(await readFile(path.join(root, "USER.md"), "utf8"), `${example.expected}\n`, example.name);
      assert.equal(await readFile(path.join(root, "history", `user-${String(revision)}.md`), "utf8"), `${example.expected}\n`, example.name);
      assert.deepEqual(await new IdentityStorage({ configDir: root }).overview(), result);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite insert receipts and separate connection reads agree on bounded text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-boundary-"));
  const writer = new MemoryStorage(root, { agentDir: root });
  const reader = new MemoryStorage(root, { agentDir: root });
  try {
    for (const example of examples(maxMemoryContentChars)) {
      const result = await writer.writeEntry({ content: example.input, tags: ["retained"], importance: 0.8 });
      assert.equal(result.written, true);
      assert.ok(result.entry);
      assert.equal(result.entry.content, example.expected, example.name);
      assert.equal((await reader.getEntry(result.entry.id))?.content, result.entry.content, example.name);
      assert.deepEqual((await reader.getEntry(result.entry.id))?.tags, ["retained"]);
    }
  } finally { writer.close(); reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite updates and archive retain equal returned and persisted content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-update-boundary-"));
  const writer = new MemoryStorage(root, { agentDir: root });
  const reader = new MemoryStorage(root, { agentDir: root });
  try {
    const original = (await writer.writeEntry({ content: "Initial fact", tags: ["unchanged"] })).entry!;
    for (const example of examples(maxMemoryContentChars)) {
      const result = await writer.updateEntry(original.id, { content: example.input });
      assert.equal(result.written, true);
      assert.equal(result.entry?.content, example.expected, example.name);
      const stored = await reader.getEntry(original.id);
      assert.equal(stored?.content, result.entry?.content, example.name);
      assert.equal(stored?.createdAt, original.createdAt);
      assert.deepEqual(stored?.tags, ["unchanged"]);
    }
    const beforeArchive = await reader.getEntry(original.id);
    const archived = await writer.archiveEntry(original.id, true);
    assert.ok(archived.entry);
    assert.equal(archived.entry.content, beforeArchive?.content);
    assert.equal((await reader.getEntry(archived.entry.id))?.content, archived.entry.content);
  } finally { writer.close(); reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("identity line normalization and memory interior line endings stay unchanged", () => {
  assert.equal(normalizeIdentityContent(" \r\nA\r\nB\rC\n ", "user"), "A\nB\nC");
  assert.equal(sanitizeMemoryEntryInput({ content: " \r\nA\r\nB\rC\n " }).content, "A\r\nB\rC");
});
