import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeHostEventJournal, writeRuntimeHostJournalAtomically } from "../src/runtime/host/journal.js";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";

const update: AgentRuntimeUpdate = {
  snapshot: {
    revision: 0,
    info: {},
    permissionMode: "ask",
    state: { kind: "idle" }
  } as unknown as AgentRuntimeUpdate["snapshot"]
};

const record = (sequence: number) => ({ sequence, update });

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-journal-test-"));
  try {
    const replacePath = path.join(root, "atomic.jsonl");
    await writeFile(replacePath, "old journal\n");
    await writeRuntimeHostJournalAtomically(replacePath, "complete replacement\n");
    assert.equal(await readFile(replacePath, "utf8"), "complete replacement\n");
    assert.deepEqual(await readdir(root), ["atomic.jsonl"], "atomic replacement cleans its temporary file");

    const journalPath = path.join(root, "events", "runtime-host-events.jsonl");
    const journal = new RuntimeHostEventJournal(journalPath, 100);
    const loaded = await journal.initialize();
    assert.deepEqual(loaded.records, []);
    const records = [record(1)];
    await journal.persist(1, () => records);
    assert.equal(journal.status(1).state, "healthy");

    const directory = path.dirname(journalPath);
    const movedDirectory = path.join(root, "events-moved");
    await rename(directory, movedDirectory);
    await writeFile(directory, "block directory creation");
    records.push(record(2));
    await journal.persist(2, () => records);
    assert.equal(journal.status(2).state, "degraded", "journal write errors must remain queryable");
    assert.equal(journal.status(2).persistedSequence, 1);

    await unlink(directory);
    await rename(movedDirectory, directory);
    records.push(record(3));
    await journal.persist(3, () => records);
    assert.deepEqual(journal.status(3), { state: "healthy", sequence: 3, persistedSequence: 3 });
    const persisted = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    assert.deepEqual(persisted.map((item) => item.sequence), [1, 2, 3], "repair rewrites the current replay window without gaps");
    await journal.close();

    const corruptPath = path.join(root, "corrupt.jsonl");
    await writeFile(corruptPath, `${JSON.stringify(record(10))}\n${JSON.stringify(record(12))}\n`);
    const corruptJournal = new RuntimeHostEventJournal(corruptPath, 100);
    const corruptLoad = await corruptJournal.initialize();
    assert.equal(corruptLoad.sequence, 12, "the event high-water must survive skipped journal rows");
    assert.deepEqual(corruptLoad.records, [], "a corrupt replay window must force gap recovery instead of partial replay");
    assert.equal(corruptJournal.status(12).state, "degraded");
    await corruptJournal.persist(13, () => [record(13)]);
    assert.equal(corruptJournal.status(13).state, "healthy", "a new atomic window repairs the journal after corruption");
    await corruptJournal.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
console.log("runtime host journal tests passed");
