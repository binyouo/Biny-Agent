import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

const range = { startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "UTC" };
const message = (content: string): string => JSON.stringify({
  type: "user_message", messageId: "shared-message", content, time: "2026-10-03T00:00:00Z"
}) + "\n";

for (const mutation of ["before-read", "during-extraction"] as const) {
  test(`temporal indexing keeps its canonical source when a directory alias changes ${mutation}`, async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-temporal-alias-")));
    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    const alias = path.join(root, "project-alias");
    const firstFile = path.join(firstDirectory, "shared-session.jsonl");
    const secondFile = path.join(secondDirectory, "shared-session.jsonl");
    const aliasFile = path.join(alias, "shared-session.jsonl");
    const firstText = "2026-10-03 项目甲交稿";
    const secondText = "2026-10-03 项目乙回访";
    let swapped = false;
    const swapAlias = async () => {
      if (swapped) return;
      swapped = true;
      await unlink(alias);
      await symlink(secondDirectory, alias);
    };
    const index = new TemporalMemoryIndex(root, { extractFacts: async (source) => {
      if (source.text === firstText && mutation === "during-extraction") await swapAlias();
      return [{ title: source.text, quote: source.text, state: "planned", eventDate: "2026-10-03", dueDate: null, completedDate: null }];
    } });
    try {
      await mkdir(firstDirectory);
      await mkdir(secondDirectory);
      await writeFile(firstFile, message(firstText));
      await writeFile(secondFile, message(secondText));
      await symlink(firstDirectory, alias);
      await index.indexSessionFile("shared-session", secondFile);
      if (mutation === "before-read") {
        const originalStat = fs.stat;
        t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
          const result = await Reflect.apply(originalStat, fs, args);
          if (String(args[0]) === aliasFile || String(args[0]) === firstFile) await swapAlias();
          return result;
        });
        syncBuiltinESMExports();
      }
      await index.indexSessionFile("shared-session", aliasFile);
      assert.equal(swapped, true);
      assert.deepEqual(index.queryClues({ ...range, sourcePaths: [firstFile] }).clues.map(clue => clue.quote), [firstText]);
      assert.deepEqual(index.queryFacts({ ...range, sourcePaths: [firstFile] }).facts.map(fact => fact.quote), [firstText]);
      assert.deepEqual(index.queryFacts({ ...range, sourcePaths: [secondFile] }).facts.map(fact => fact.quote), [secondText]);
      assert.equal(await readFile(firstFile, "utf8"), message(firstText));
      assert.equal(await readFile(secondFile, "utf8"), message(secondText));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      index.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("date details and temporal projections isolate same-named sessions by source file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-source-"));
  const projects = ["first", "second"].map((id) => ({ id, path: path.join(root, id) }));
  const files: string[] = [];
  const texts = ["2026-10-03 项目甲交稿", "2026-10-03 项目乙回访"];
  const index = new TemporalMemoryIndex(root, { extractFacts: async (source) => [{
    title: source.text, quote: source.text, state: "planned", eventDate: "2026-10-03", dueDate: null, completedDate: null
  }] });
  const service = new DateReferenceDetailService(root);
  try {
    for (const [position, project] of projects.entries()) {
      await mkdir(project.path);
      const directory = projectSessionsDir(project.path, { env: { BINY_AGENT_DIR: root } });
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "shared-session.jsonl");
      files.push(file);
      await writeFile(file, message(texts[position]!));
    }
    await index.refreshAll();
    for (const [position, project] of projects.entries()) {
      const detail = await service.query(range, [project]);
      assert.deepEqual(detail.clues.map((clue) => clue.quote), [texts[position]], "project clues must come from its own file");
      assert.deepEqual(detail.facts.map((fact) => fact.quote), [texts[position]], "project facts must come from its own file");
      assert.deepEqual(detail.conversations.map((hit) => hit.quote), [texts[position]]);
    }
    assert.deepEqual(index.queryClues(range).clues.map((clue) => clue.quote).sort(), [...texts].sort());
    assert.deepEqual(index.queryFacts(range).facts.map((fact) => fact.quote).sort(), [...texts].sort());
    const originalIds = index.queryClues(range).clues.map((clue) => clue.id);
    assert.equal(new Set(originalIds).size, 2);
    await index.indexSessionFile("shared-session", files[0]!);
    assert.deepEqual(index.queryClues(range).clues.map((clue) => clue.id), originalIds);
    service.close();
    const reopened = new DateReferenceDetailService(root);
    try {
      assert.deepEqual((await reopened.query(range, [projects[1]!])).facts.map((fact) => fact.quote), [texts[1]]);
      await rm(files[0]!);
      assert.deepEqual((await reopened.query(range, [projects[0]!])).clues, []);
      assert.deepEqual((await reopened.query(range, [projects[1]!])).facts.map((fact) => fact.quote), [texts[1]]);
      assert.equal(await readFile(files[1]!, "utf8"), message(texts[1]!));
    } finally { reopened.close(); }
  } finally {
    service.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy temporal state migrates only with matching file and text while unbound records remain untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-legacy-source-"));
  const projects = ["owner", "copy"].map((id) => ({ id, path: path.join(root, id) }));
  const files: string[] = [];
  const text = "2026-10-03 开会，2026-10-04 交稿";
  const sourceHash = createHash("sha256").update(JSON.stringify([text, "2026-10-03T00:00:00Z", null])).digest("hex");
  const legacyId = createHash("sha256").update(JSON.stringify(["shared-session", "shared-message"])).digest("hex");
  const database = new DatabaseSync(path.join(root, "temporal-memory.sqlite"));
  const index = new TemporalMemoryIndex(root);
  const service = new DateReferenceDetailService(root);
  try {
    for (const project of projects) {
      await mkdir(project.path);
      const directory = projectSessionsDir(project.path, { env: { BINY_AGENT_DIR: root } });
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "shared-session.jsonl");
      files.push(file);
      await writeFile(file, message(text));
    }
    const memoryFile = path.join(root, "memory.sqlite");
    await writeFile(memoryFile, "unrelated long-term memory sentinel");
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE temporal_sources(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,source_hash TEXT NOT NULL,sent_at TEXT,time_zone TEXT,parser TEXT NOT NULL,facts_indexed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE temporal_session_files(session_id TEXT PRIMARY KEY,file_path TEXT NOT NULL);
      CREATE TABLE temporal_clues(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES temporal_sources(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id TEXT NOT NULL,expression TEXT NOT NULL,date TEXT,end_date TEXT,time TEXT,offset INTEGER NOT NULL,quote TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE temporal_seen(day TEXT NOT NULL,clue_id TEXT NOT NULL REFERENCES temporal_clues(id) ON DELETE CASCADE,PRIMARY KEY(day,clue_id));
      CREATE TABLE temporal_facts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES temporal_sources(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id TEXT NOT NULL,title TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL,event_date TEXT,due_date TEXT,completed_date TEXT);
    `);
    database.prepare("INSERT INTO temporal_sources VALUES(?,?,?,?,?,?,?,?)").run(legacyId, "shared-session", "shared-message", sourceHash, "2026-10-03T00:00:00Z", null, "grammar", 1);
    database.prepare("INSERT INTO temporal_sources VALUES(?,?,?,?,?,?,?,?)").run("unbound", "unknown-session", "unknown-message", "unverified-hash", "2026-10-03T00:00:00Z", null, "model", 1);
    database.prepare("INSERT INTO temporal_session_files VALUES(?,?)").run("shared-session", files[0]!);
    for (const [position, date] of ["2026-10-03", "2026-10-04"].entries()) {
      database.prepare("INSERT INTO temporal_clues VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`legacy-${position}`, legacyId, "shared-session", "shared-message", date, date, null, null, text.indexOf(date), text, position);
    }
    database.prepare("INSERT INTO temporal_seen VALUES(?,?)").run("2026-10-03", "legacy-0");
    database.prepare("INSERT INTO temporal_facts VALUES(?,?,?,?,?,?,?,?,?,?)").run("legacy-fact", legacyId, "shared-session", "shared-message", "开会", text, "planned", "2026-10-03", null, null);
    database.prepare("INSERT INTO temporal_facts VALUES(?,?,?,?,?,?,?,?,?,?)").run("unbound-fact", "unbound", "unknown-session", "unknown-message", "旧事实", "2026-10-03 旧事实", "planned", "2026-10-03", null, null);
    const editedFile = path.join(path.dirname(files[0]!), "edited-session.jsonl");
    const editedText = "2026-10-09 修改后的原文";
    await writeFile(editedFile, message(editedText));
    const editedLegacyId = createHash("sha256").update(JSON.stringify(["edited-session", "shared-message"])).digest("hex");
    database.prepare("INSERT INTO temporal_sources VALUES(?,?,?,?,?,?,?,?)").run(editedLegacyId, "edited-session", "shared-message", sourceHash, "2026-10-03T00:00:00Z", null, "grammar", 1);
    database.prepare("INSERT INTO temporal_session_files VALUES(?,?)").run("edited-session", editedFile);
    database.prepare("INSERT INTO temporal_facts VALUES(?,?,?,?,?,?,?,?,?,?)").run("edited-fact", editedLegacyId, "edited-session", "shared-message", "修改前事实", text, "planned", "2026-10-03", null, null);
    await index.indexSessionFile("shared-session", files[1]!);
    assert.equal(index.queryFacts({ ...range, sourcePaths: [files[1]!] }).facts.length, 0, "a same-text copy must not inherit the owner's explicit facts");
    assert.equal(index.queryFacts(range).facts.length, 3, "global queries retain legacy facts before source verification");
    const ownerDetail = await service.query({ ...range, endDate: "2026-10-05" }, [projects[0]!]);
    assert.deepEqual(ownerDetail.clues.map((clue) => clue.date), ["2026-10-03"], "migration preserves the ignored clue");
    assert.deepEqual(ownerDetail.facts.map((fact) => fact.title), ["开会"]);
    const ownerPage = index.queryClues({ ...range, today: "2026-10-03", sourcePaths: [files[0]!] });
    assert.equal(ownerPage.clues[0]?.seen, true);
    assert.equal(ownerPage.unread, 0);
    assert.equal(index.queryClues({ ...range, today: "2026-10-03", sourcePaths: [files[1]!] }).unread, 1);
    assert.deepEqual(index.queryClues({ ...range, sourcePaths: [] }).clues, []);
    assert.deepEqual(index.queryFacts({ ...range, sourcePaths: [files[1]!] }).facts, []);
    index.close();
    await index.refreshAll();
    assert.equal(index.queryClues({ ...range, today: "2026-10-03", sourcePaths: [files[0]!] }).clues[0]?.seen, true);
    assert.equal(index.queryFacts(range).facts.length, 3);
    assert.equal(index.queryFacts(range).facts.find((fact) => fact.id === "unbound-fact")?.sourcePath, undefined);
    assert.equal(index.queryFacts(range).facts.find((fact) => fact.id === "edited-fact")?.sourcePath, undefined);
    assert.deepEqual(index.queryFacts({ ...range, sourcePaths: [editedFile] }).facts, [], "a matching path with changed text must not inherit legacy facts");
    assert.deepEqual(database.prepare("SELECT source_hash,source_path FROM temporal_sources WHERE id='unbound'").get(), Object.assign(Object.create(null), { source_hash: "unverified-hash", source_path: null }));
    assert.equal(await readFile(memoryFile, "utf8"), "unrelated long-term memory sentinel");
    for (const file of files) assert.equal(await readFile(file, "utf8"), message(text));
    assert.equal(await readFile(editedFile, "utf8"), message(editedText));
  } finally {
    database.close();
    service.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
