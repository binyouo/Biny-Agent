import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DesktopSkillService } from "../src/desktop/electron/main/DesktopSkillService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { defaultConfig } from "../src/config/schema.js";

test("single-skill reads inspect the selected project only and revalidate moved paths", async context => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-skill-scope-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  context.mock.method(os, "homedir", () => path.join(root, "home"));
  const state = new DesktopStateStore(path.join(root, "desktop.json"));
  try {
    for (const id of ["selected", "unrelated"]) {
      const directory = path.join(root, id, ".agents", "skills", `${id}-skill`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${id}-skill\ndescription: Synthetic scope fixture\n---\n${id} body\n`);
      await state.upsertProject({ id, name: id, path: path.join(root, id), dirty: false, missing: false, pinned: false,
        addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
    }
    const service = new DesktopSkillService(state, { load: async () => defaultConfig, save: async () => { throw new Error("unexpected write"); } });
    const skill = (await service.snapshot("selected")).skills.find(item => item.name === "selected-skill")!;
    const inspected: string[] = [];
    const skillPaths: string[] = [];
    const original = fs.lstat;
    context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const candidate = String(args[0]);
      if (candidate.includes(`${path.sep}skills`)) skillPaths.push(candidate);
      if (candidate.startsWith(path.join(root, "unrelated"))) inspected.push(candidate);
      return await original(...args);
    });
    assert.deepEqual((await service.pluginCatalog("selected")).plugins, []);
    assert.deepEqual(skillPaths, [], "the installed-plugin endpoint does not inspect skill roots");
    const [preview, managed] = await Promise.all([service.readFile(skill.id, "SKILL.md", "selected"), service.version(skill.id, "selected")]);
    assert.match(preview.content ?? "", /selected body/u);
    assert.equal(managed, undefined);
    assert.deepEqual(inspected, [], "reading one skill must not scan another project's roots");
    await assert.rejects(service.readFile(skill.id, "SKILL.md", "unrelated"), /Skill 不存在/u);
    await assert.rejects(service.readFile(skill.id, "../outside", "selected"), /越界/u);
    const outside = path.join(root, "outside");
    await fs.rename(skill.absolutePath, outside);
    await fs.symlink(outside, skill.absolutePath, "dir");
    await assert.rejects(service.readFile(skill.id, "SKILL.md", "selected"), /Skill 不存在/u);
  } finally {
    context.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
