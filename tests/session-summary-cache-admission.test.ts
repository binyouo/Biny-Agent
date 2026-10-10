import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { querySessionCatalog } from "../src/session/catalog.js";
import { readSessionSummary } from "../src/session/events.js";
import { measureSessionRead } from "./helpers/sessionReadMetrics.js";

const time = "2026-10-09T00:00:00.000Z";
const budget = 8 * 1024 * 1024;

async function fixture(run: (workspace: string, write: (id: string, content: string) => Promise<void>) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-summary-admission-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const directory = projectSessionsDir(await fs.realpath(workspace));
    await fs.mkdir(directory, { recursive: true });
    await run(workspace, async (id, content) => {
      await fs.writeFile(path.join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "user_message", content, time })}\n`);
    });
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("oversized ASCII and UTF-8 summaries do not evict healthy entries, including same-path growth", async () => {
  for (const content of ["x".repeat(9 * 1024 * 1024), "中".repeat(3 * 1024 * 1024)]) {
    await fixture(async (workspace, write) => {
      await write("healthy", "unchanged");
      await write("growing", "previous small summary");
      const healthy = await readSessionSummary(workspace, "healthy.jsonl");
      await readSessionSummary(workspace, "growing.jsonl");
      await write("growing", content);
      for (let repeat = 0; repeat < 2; repeat++) {
        const oversized = await measureSessionRead(() => readSessionSummary(workspace, "growing.jsonl"));
        assert.equal(oversized.value?.firstUserMessage, content, "the returned summary must remain complete");
        assert.ok(oversized.metrics.bytesRead > budget, "oversized summaries are not retained");
        const retained = await measureSessionRead(() => readSessionSummary(workspace, "healthy.jsonl"));
        assert.deepEqual(retained.value, healthy);
        assert.equal(retained.metrics.bytesRead, 0, "an uncacheable entry must not flush healthy summaries");
      }
      await write("growing", "new small summary");
      assert.equal((await readSessionSummary(workspace, "growing.jsonl"))?.firstUserMessage, "new small summary");
      const shrunk = await measureSessionRead(() => readSessionSummary(workspace, "growing.jsonl"));
      assert.equal(shrunk.value?.firstUserMessage, "new small summary");
      assert.equal(shrunk.metrics.bytesRead, 0, "a changed path can become cacheable again");
    });
  }
});

test("the byte budget admits an exact-fit summary and rejects one byte more without collateral eviction", async () => {
  await fixture(async (workspace, write) => {
    await write("boundary", "");
    const empty = await readSessionSummary(workspace, "boundary.jsonl");
    assert.ok(empty);
    const content = "b".repeat(budget - Buffer.byteLength(JSON.stringify(empty)) - 256);
    await write("boundary", content);
    const exact = await readSessionSummary(workspace, "boundary.jsonl");
    assert.equal(Buffer.byteLength(JSON.stringify(exact)) + 256, budget);
    const cached = await measureSessionRead(() => readSessionSummary(workspace, "boundary.jsonl"));
    assert.deepEqual(cached.value, exact);
    assert.equal(cached.metrics.bytesRead, 0, "an exact-fit entry remains cacheable");
    await write("healthy", "retained after exact-fit eviction");
    await readSessionSummary(workspace, "healthy.jsonl");
    await write("boundary", content + "b");
    const oversized = await readSessionSummary(workspace, "boundary.jsonl");
    assert.equal(Buffer.byteLength(JSON.stringify(oversized)) + 256, budget + 1);
    const retained = await measureSessionRead(() => readSessionSummary(workspace, "healthy.jsonl"));
    assert.equal(retained.metrics.bytesRead, 0);
  });
});

test("catalog continuation preserves data and avoids rereading small histories after an oversized summary", async () => {
  await fixture(async (workspace, write) => {
    for (let index = 0; index < 4; index++) await write(`small-${index}`, `message ${index}`);
    await write("z-large", "x".repeat(9 * 1024 * 1024));
    const first = await querySessionCatalog(workspace, { limit: 2 });
    const coldNext = await querySessionCatalog(workspace, { limit: 2, cursor: first.nextCursor });
    const warmNext = await measureSessionRead(() => querySessionCatalog(workspace, { limit: 2, cursor: first.nextCursor }));
    assert.deepEqual(warmNext.value, coldNext, "items, revision and cursor must remain identical");
    assert.equal(warmNext.value.revisionChanged, false);
    assert.deepEqual(warmNext.value.items.map((item) => item.id), ["small-2", "small-1"]);
    const small = await measureSessionRead(() => readSessionSummary(workspace, "small-0.jsonl"));
    assert.equal(small.metrics.bytesRead, 0);
  });
});
