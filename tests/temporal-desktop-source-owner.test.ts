import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectSessionsDir } from "../src/config/paths.js";
import { DesktopTemporalMemoryService, type DesktopTemporalPage } from "../src/desktop/temporalMemoryService.js";

type Project = { id: string; path: string };

for (const count of [1, 2, 3]) {
  test(`${count} registered projects retain each clue's source owner despite matching session IDs`, async () => {
    await fixture(count, count, async (page, projects) => {
      assert.equal(page.clues.length, count);
      for (const clue of page.clues) {
        const owner = projects.find(project => clue.quote.includes(project.id));
        assert.ok(owner);
        assert.equal(clue.projectId, owner.id);
      }
    });
  });
}

test("unregistered source cannot borrow registered same-ID session navigation", async () => {
  await fixture(2, 1, async (page, projects) => {
    assert.equal(page.clues.length, 2);
    assert.equal(page.clues.find(clue => clue.quote.includes(projects[0]!.id))!.projectId, projects[0]!.id);
    assert.equal(page.clues.find(clue => clue.quote.includes(projects[1]!.id))!.projectId, undefined);
  });
});

test("pagination retains source-specific project IDs on every page", async () => {
  await fixture(3, 3, async (page, projects, service) => {
    const collected: string[] = [];
    let offset = 0;
    while (true) {
      const next = await service.query({ startDate: "2026-10-03", endDate: "2026-10-04", limit: 1, offset }, projects);
      assert.equal(next.clues.length, 1);
      const clue = next.clues[0]!;
      assert.equal(clue.projectId, projects.find(project => clue.quote.includes(project.id))?.id);
      collected.push(clue.id);
      if (!next.hasMore) break;
      assert.ok(next.nextOffset !== null && next.nextOffset > offset);
      offset = next.nextOffset;
    }
    assert.deepEqual(collected, page.clues.map(clue => clue.id));
  });
});

test("missing project directory cannot lend another project's identity", async () => {
  await fixture(2, 2, async (_page, projects, service) => {
    await rm(projects[1]!.path, { recursive: true });
    const next = await service.query({ startDate: "2026-10-03", endDate: "2026-10-04" }, projects);
    assert.equal(next.clues.length, 2);
    assert.equal(next.clues.find(clue => clue.quote.includes(projects[0]!.id))!.projectId, projects[0]!.id);
    assert.equal(next.clues.find(clue => clue.quote.includes(projects[1]!.id))!.projectId, undefined);
  });
});

async function fixture(count: number, registered: number, run: (
  page: DesktopTemporalPage, projects: Project[], service: DesktopTemporalMemoryService
) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-temporal-owner-")));
  const projects = Array.from({ length: count }, (_, i) => ({ id: `project-${i}`, path: path.join(root, `workspace-${i}`) }));
  const service = new DesktopTemporalMemoryService(root);
  try {
    for (const project of projects) {
      await mkdir(project.path);
      const directory = projectSessionsDir(project.path, { env: { BINY_AGENT_DIR: root } });
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "shared-session.jsonl"), JSON.stringify({
        type: "user_message", messageId: "shared-message", content: `2026-10-03 ${project.id} meeting`, time: "2026-10-02T00:00:00Z"
      }) + "\n");
    }
    const page = await service.query({ startDate: "2026-10-03", endDate: "2026-10-04" }, projects.slice(0, registered));
    assert.equal(new Set(page.clues.map(clue => clue.sourcePath)).size, count, "real index preserves distinct source paths");
    await run(page, projects, service);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
