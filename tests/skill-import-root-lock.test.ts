import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withGlobalConfigWriteLock } from "../src/config/versioned.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../src/extensions/skillImports.js";

const document = (name: string, body = "ORIGINAL_USER_INSTRUCTIONS") => `---\nname: ${name}\ndescription: A synthetic report workflow.\n---\n\n# Report\n\n${body}\n`;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext, directory = "weekly-report") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "biny-skill-import-root-lock-"));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const source = path.join(home, ".agents", "skills", directory);
  const root = path.join(home, ".config", "biny", "skills");
  await fs.mkdir(source, { recursive: true });
  const original = document("weekly-report");
  await fs.writeFile(path.join(source, "SKILL.md"), original);
  const candidates = listUnmanagedSkillCandidates(await scanSkillCatalog({ homeDir: home }));
  assert.equal(candidates.length, 1);
  return { home, root, source, original, id: candidates[0]!.id, target: path.join(root, directory) };
}

test("skill import waits for the shared root lock and scans after its writer finishes", async t => {
  const f = await fixture(t);
  const acquired = gate(), release = gate();
  const owner = withGlobalConfigWriteLock(f.root, async () => {
    acquired.resolve();
    await release.promise;
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, "SKILL.md"), document("weekly-report", "OTHER_WRITER"));
  });
  await acquired.promise;
  let pending: ReturnType<typeof importUnmanagedSkills> | undefined;
  try {
    pending = importUnmanagedSkills({ homeDir: f.home, ids: [f.id] });
    // Give the in-flight importer normal filesystem turns while the root remains owned.
    await fs.readFile(path.join(f.source, "SKILL.md"));
    release.resolve();
    await owner;
    assert.deepEqual(await pending, []);
    assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), document("weekly-report", "OTHER_WRITER"));
    assert.equal(await fs.readFile(path.join(f.source, "SKILL.md"), "utf8"), f.original);
  } finally {
    release.resolve();
    await Promise.allSettled([owner, ...(pending ? [pending] : [])]);
  }
});

test("skill imports in different managed roots do not share a lock", async t => {
  const first = await fixture(t), second = await fixture(t);
  const acquired = gate(), release = gate();
  const owner = withGlobalConfigWriteLock(first.root, async () => { acquired.resolve(); await release.promise; });
  await acquired.promise;
  try {
    const result = await importUnmanagedSkills({ homeDir: second.home, ids: [second.id] });
    assert.equal(result[0]?.alreadyInstalled, false);
    assert.equal(await fs.readFile(path.join(second.target, "SKILL.md"), "utf8"), second.original);
  } finally { release.resolve(); await owner; }
});

test("an import business validation failure releases the root for the next import", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "oversized.bin"), Buffer.alloc(32 * 1024 * 1024));
  await assert.rejects(importUnmanagedSkills({ homeDir: f.home, ids: [f.id] }), /Skill 总大小超过/u);
  const validSource = path.join(f.home, ".agents", "skills", "valid-report");
  await fs.mkdir(validSource);
  await fs.writeFile(path.join(validSource, "SKILL.md"), document("valid-report"));
  const candidates = listUnmanagedSkillCandidates(await scanSkillCatalog({ homeDir: f.home }));
  const valid = candidates.find(candidate => candidate.name === "valid-report");
  assert.ok(valid);
  const result = await importUnmanagedSkills({ homeDir: f.home, ids: [valid.id] });
  assert.equal(result[0]?.alreadyInstalled, false);
  assert.equal(await fs.readFile(path.join(f.source, "SKILL.md"), "utf8"), f.original);
});

test("concurrent same-root imports return only one successful installation", async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    importUnmanagedSkills({ homeDir: f.home, ids: [f.id] }),
    importUnmanagedSkills({ homeDir: f.home, ids: [f.id] })
  ]);
  assert.deepEqual(results.map(result => result.length).sort(), [0, 1]);
  assert.equal(results.flat()[0]?.alreadyInstalled, false);
  assert.equal(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8"), f.original);
  assert.equal(await fs.readFile(path.join(f.source, "SKILL.md"), "utf8"), f.original);
});

test("empty skill selection remains a no-op", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "biny-skill-empty-selection-"));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  assert.deepEqual(await importUnmanagedSkills({ homeDir: home, ids: [] }), []);
  assert.deepEqual(await fs.readdir(home), []);
});
