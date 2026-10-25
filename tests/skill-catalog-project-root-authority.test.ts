import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readSkillCatalogFile, scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { loadSkills } from "../src/extensions/skills.js";

// Only repository bundled skills and synthetic temporary files are inspected.
async function fixture(context: TestContext, run: (f: { root: string; home: string; project: string }) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-skill-root-authority-")));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await fs.mkdir(home);
  await fs.mkdir(project);
  // Bound repository-ancestor discovery to this synthetic project.
  await fs.mkdir(path.join(project, ".git"));
  const prior = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(home, ".config", "biny");
  context.mock.method(os, "homedir", () => home);
  try { await run({ root, home, project }); }
  finally {
    context.mock.restoreAll();
    if (prior === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function skill(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Inert synthetic fixture\n---\nSynthetic body only.\n`);
  await fs.writeFile(path.join(directory, "marker.txt"), "SYNTHETIC MARKER");
  return directory;
}

for (const ancestor of [".agents", ".biny"]) {
  test(`catalog rejects project ${ancestor} ancestor link before external metadata reads`, async (context) => {
    await fixture(context, async ({ root, home, project }) => {
      const external = path.join(root, "external");
      const externalSkill = await skill(path.join(external, "skills"), "outside-demo");
      const siblingRoot = ancestor === ".agents" ? ".biny" : ".agents";
      await skill(path.join(project, siblingRoot, "skills"), "inside-demo");
      await fs.symlink(external, path.join(project, ancestor), "dir");
      const externalOpens: string[] = [];
      const originalOpen = fs.open;
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const candidate = String(args[0]);
        if (candidate.startsWith(`${external}${path.sep}`)) externalOpens.push(path.relative(external, candidate));
        return await originalOpen(...args);
      });
      // The runtime already rejects this project path; no Host or Agent is started.
      await assert.rejects(loadSkills({ workspaceRoot: project, projectPaths: [], globalRoot: path.join(home, "absent") }), /escapes workspace|symbolic links/);
      const snapshot = await scanSkillCatalog({ homeDir: home, projectRoots: [project] });
      const discovered = snapshot.skills.find((entry) => entry.name === "outside-demo");
      const metadataOpens = [...externalOpens];
      // This optional observation proves full-preview reach using only synthetic text.
      if (discovered) {
        const preview = await readSkillCatalogFile(discovered, "marker.txt");
        context.diagnostic(`External fixture exposed as ${discovered.scope}; canonical directory matches=${discovered.absolutePath === externalSkill}; preview=${preview.content}`);
      }
      assert.deepEqual({
        externalMetadataOpens: metadataOpens,
        externalInInventory: snapshot.inventory.some((entry) => entry.name === "outside-demo"),
        siblingPresent: snapshot.skills.some((entry) => entry.name === "inside-demo"),
        rootDiagnostic: snapshot.diagnostics.some((diagnostic) => diagnostic.kind === "unsupported_root" && diagnostic.path === path.join(project, ancestor, "skills"))
      }, {
        externalMetadataOpens: [], externalInInventory: false, siblingPresent: true, rootDiagnostic: true
      });
    });
  });
}

test("direct project root and child links remain rejected; ordinary project skills remain visible", async (context) => {
  await fixture(context, async ({ root, home, project }) => {
    const external = await skill(path.join(root, "external"), "outside-demo");
    await skill(path.join(project, ".agents", "skills"), "inside-demo");
    await fs.symlink(external, path.join(project, ".agents", "skills", "outside-demo"), "dir");
    await fs.mkdir(path.join(project, ".biny"));
    await fs.symlink(path.dirname(external), path.join(project, ".biny", "skills"), "dir");
    const snapshot = await scanSkillCatalog({ homeDir: home, projectRoots: [project] });
    assert.equal(snapshot.inventory.some((entry) => entry.name === "outside-demo"), false);
    assert.equal(snapshot.skills.some((entry) => entry.name === "inside-demo"), true);
    assert.ok(snapshot.diagnostics.some((entry) => entry.kind === "unsupported_root"));
    assert.ok(snapshot.diagnostics.some((entry) => entry.kind === "unsupported_symlink"));
    const runtime = await loadSkills({ workspaceRoot: project, projectPaths: [], globalRoot: path.join(home, "absent") });
    assert.equal(runtime.skills.some((entry) => entry.name === "inside-demo"), true);
    assert.equal(runtime.skills.some((entry) => entry.name === "outside-demo"), false);
  });
});

test("intentional global links and canonical project-root aliases remain supported", async (context) => {
  await fixture(context, async ({ root, home, project }) => {
    const global = await skill(path.join(home, ".claude", "skills"), "global-demo");
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await fs.symlink(global, path.join(home, ".agents", "skills", "global-demo"), "dir");
    await skill(path.join(project, ".agents", "skills"), "inside-demo");
    const alias = path.join(root, "project-alias");
    await fs.symlink(project, alias, "dir");
    const snapshot = await scanSkillCatalog({ homeDir: home, projectRoots: [alias] });
    assert.equal(snapshot.skills.find((entry) => entry.name === "global-demo")?.absolutePath, global);
    assert.equal(snapshot.skills.find((entry) => entry.name === "inside-demo")?.projectRoot, project);
    assert.deepEqual(snapshot.diagnostics.filter((entry) => entry.kind !== "duplicate_id"), []);
    const runtime = await loadSkills({ workspaceRoot: alias, projectPaths: [] });
    assert.equal(runtime.skills.find((entry) => entry.name === "global-demo")?.filePath, path.join(global, "SKILL.md"));
    assert.equal(runtime.skills.find((entry) => entry.name === "inside-demo")?.rootPath, project);
    assert.deepEqual(runtime.errors, []);
  });
});

test("rejected project ancestor root cannot authorize a global link to an otherwise unsupported directory", async (context) => {
  await fixture(context, async ({ root, home, project }) => {
    const external = path.join(root, "external");
    const outside = await skill(path.join(external, "skills"), "outside-demo");
    await fs.symlink(external, path.join(project, ".agents"), "dir");
    const globalRoot = path.join(home, ".claude", "skills");
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.symlink(outside, path.join(globalRoot, "outside-demo"), "dir");
    const opened: string[] = [];
    const originalOpen = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const candidate = String(args[0]);
      if (candidate.startsWith(`${external}${path.sep}`)) opened.push(path.relative(external, candidate));
      return await originalOpen(...args);
    });
    const snapshot = await scanSkillCatalog({ homeDir: home, projectRoots: [project] });
    assert.deepEqual({
      opened,
      outsidePresent: snapshot.inventory.some((entry) => entry.name === "outside-demo"),
      globalLinkRejected: snapshot.diagnostics.some((entry) => entry.kind === "unsupported_symlink" && entry.path === path.join(globalRoot, "outside-demo"))
    }, { opened: [], outsidePresent: false, globalLinkRejected: true });
  });
});

for (const ancestor of [".agents", ".biny"]) {
  test(`project ${ancestor} inward ancestor alias is rejected without losing ordinary sibling`, async (context) => {
    await fixture(context, async ({ home, project }) => {
      const inward = path.join(project, "aliased-content");
      await skill(path.join(inward, "skills"), "alias-demo");
      const siblingRoot = ancestor === ".agents" ? ".biny" : ".agents";
      await skill(path.join(project, siblingRoot, "skills"), "inside-demo");
      await fs.symlink(inward, path.join(project, ancestor), "dir");
      await assert.rejects(loadSkills({ workspaceRoot: project, projectPaths: [], globalRoot: path.join(home, "absent") }), /symbolic links/);
      const snapshot = await scanSkillCatalog({ homeDir: home, projectRoots: [project] });
      assert.deepEqual({
        aliasPresent: snapshot.inventory.some((entry) => entry.name === "alias-demo"),
        siblingPresent: snapshot.skills.some((entry) => entry.name === "inside-demo"),
        rootDiagnostic: snapshot.diagnostics.some((entry) => entry.kind === "unsupported_root" && entry.path === path.join(project, ancestor, "skills"))
      }, { aliasPresent: false, siblingPresent: true, rootDiagnostic: true });
    });
  });
}
