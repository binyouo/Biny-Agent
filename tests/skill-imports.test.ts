import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../src/extensions/skillImports.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-import-"));
  try {
    const homeDir = path.join(root, "home");
    const source = path.join(homeDir, ".claude", "skills", "import-me");
    const agentsRoot = path.join(homeDir, ".agents", "skills");
    await mkdir(path.join(source, "references"), { recursive: true });
    await mkdir(agentsRoot, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: import-me\ndescription: Import me\n---\n\n# Import\n");
    await writeFile(path.join(source, "references", "guide.md"), "# Guide\n");
    await symlink(source, path.join(agentsRoot, "import-me"), "dir");

    const snapshot = await scanSkillCatalog({ homeDir });
    const candidates = listUnmanagedSkillCandidates(snapshot);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.name, "import-me");
    assert.deepEqual(candidates[0]?.foundIn, ["claude", "codex", "pi"]);

    const results = await importUnmanagedSkills({ homeDir, ids: [candidates[0]!.id] });
    assert.deepEqual(results.map((result) => ({ name: result.name, alreadyInstalled: result.alreadyInstalled })), [{ name: "import-me", alreadyInstalled: false }]);
    assert.equal(await readFile(path.join(homeDir, ".config", "biny", "skills", "import-me", "references", "guide.md"), "utf8"), "# Guide\n");
    assert.equal((await lstat(path.join(agentsRoot, "import-me"))).isSymbolicLink(), true);

    const afterImport = await scanSkillCatalog({ homeDir });
    assert.equal(afterImport.warnings.length, 0);
    assert.equal(afterImport.skills.some((skill) => skill.source === "biny" && skill.name === "import-me"), true);
    assert.equal(listUnmanagedSkillCandidates(afterImport).length, 0);

    const unsafeSource = path.join(homeDir, ".claude", "skills", "unsafe-skill");
    await mkdir(unsafeSource);
    const unsafeDocument = "---\nname: unsafe-skill\ndescription: Unsafe resource fixture\n---\n";
    await writeFile(path.join(unsafeSource, "SKILL.md"), unsafeDocument);
    const externalFile = path.join(root, "external.txt");
    await writeFile(externalFile, "External source bytes.\n");
    await symlink(externalFile, path.join(unsafeSource, "linked.txt"));
    await symlink(unsafeSource, path.join(agentsRoot, "unsafe-skill"), "dir");
    const unsafe = listUnmanagedSkillCandidates(await scanSkillCatalog({ homeDir })).find(candidate => candidate.name === "unsafe-skill");
    assert.ok(unsafe);
    await assert.rejects(importUnmanagedSkills({ homeDir, ids: [unsafe.id] }), /资源不能是符号链接/u);
    await assert.rejects(lstat(path.join(homeDir, ".config", "biny", "skills", "unsafe-skill")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(unsafeSource, "SKILL.md"), "utf8"), unsafeDocument);
    assert.equal(await readFile(externalFile, "utf8"), "External source bytes.\n");
    assert.equal(await readFile(path.join(homeDir, ".config", "biny", "skills", "import-me", "references", "guide.md"), "utf8"), "# Guide\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
