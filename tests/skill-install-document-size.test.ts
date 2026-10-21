/** 远程安装和运行时共享完整文档与头部边界，较长正文不会被误当作超长元数据。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installDiscoveredSkill } from "../src/extensions/skillDiscovery.js";
import { loadSkills } from "../src/extensions/skills.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-install-size-"));
let document = `---\nname: size-fixture\ndescription: Shared file boundaries\n---\n${"x".repeat(70_000)}`;
const fetcher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: "a".repeat(40) }));
  if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [{ path: "size-fixture/SKILL.md", type: "blob", size: Buffer.byteLength(document) }] }));
  return new Response(document);
};
const options = { skill: { name: "size-fixture", directory: "size-fixture", repoOwner: "fixture", repoName: "skills", repoBranch: "main" }, fetcher };
try {
  const installed = await installDiscoveredSkill({ ...options, homeDir: path.join(root, "valid") });
  assert.equal(await readFile(path.join(installed.installedPath, "SKILL.md"), "utf8"), document);
  const bundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.dirname(installed.installedPath) });
  assert.ok(bundle.skills.some((skill) => skill.name === "size-fixture"));
  document = `---\nname: size-fixture\ndescription: Shared file boundaries\nmetadata:\n  padding: ${"x".repeat(65_536)}\n---\nBody`;
  await assert.rejects(installDiscoveredSkill({ ...options, homeDir: path.join(root, "bad-header") }), /frontmatter/u);
  document = `---\nname: size-fixture\ndescription: Shared file boundaries\n---\n${"x".repeat(512 * 1024)}`;
  await assert.rejects(installDiscoveredSkill({ ...options, homeDir: path.join(root, "too-large") }), /524288|512 KiB/u);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("remote Skill document size tests passed");
