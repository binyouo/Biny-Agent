import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installDiscoveredSkill, searchSkillsSh } from "../src/extensions/skillDiscovery.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-tools-"));
  const homeDir = path.join(root, "home");
  const fetcher: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("skills.sh/api/search")) {
      return response(JSON.stringify({
        query: "demo",
        count: 1,
        skills: [{
          id: "demo-owner/demo-skills:skills/demo",
          skillId: "skills/demo",
          name: "demo-skill",
          installs: 7,
          source: "demo-owner/demo-skills"
        }]
      }));
    }
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha: "a".repeat(40) }));
    if (url.includes("/git/trees/")) {
      return response(JSON.stringify({ tree: [
        { path: "skills/demo/SKILL.md", type: "blob", size: 64 },
        { path: "skills/demo/references/guide.md", type: "blob", size: 10 }
      ] }));
    }
    if (url.endsWith("/skills/demo/SKILL.md")) return response("---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");
    if (url.endsWith("/skills/demo/references/guide.md")) return response("# Guide\n");
    return response("not found", 404);
  };

  try {
    const searched = await searchSkillsSh({ query: "demo", fetcher, installedNames: new Set(["already-installed"]) });
    assert.equal(searched.skills[0]?.directory, "skills/demo");
    assert.equal(searched.skills[0]?.installed, false);

    const installed = await installDiscoveredSkill({ homeDir, fetcher, skill: searched.skills[0]! });
    assert.equal(installed.name, "demo-skill");
    assert.equal(installed.diagnostic.status, "unverified");
    assert.equal(await readFile(path.join(homeDir, ".config", "biny", "skills", "demo-skill", "SKILL.md"), "utf8"), "---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");

    // 默认分支非 main/master 的仓库：commits 404 后查仓库默认分支再装。
    const developHome = path.join(root, "develop-home");
    const developFetches: string[] = [];
    const developFetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/commits/main") || url.includes("/commits/master")) return response("not found", 404);
      if (url.endsWith("/repos/demo-owner/demo-skills") && !url.includes("/commits") && !url.includes("/git/")) {
        developFetches.push("repo-info");
        return response(JSON.stringify({ default_branch: "develop" }));
      }
      if (url.includes("/commits/develop")) {
        developFetches.push("commit-develop");
        return response(JSON.stringify({ sha: "b".repeat(40) }));
      }
      if (url.includes("/git/trees/")) return response(JSON.stringify({ tree: [{ path: "skills/demo/SKILL.md", type: "blob", size: 64 }] }));
      if (url.endsWith("/skills/demo/SKILL.md")) return response("---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");
      return response("not found", 404);
    };
    const developed = await installDiscoveredSkill({ homeDir: developHome, fetcher: developFetcher, skill: searched.skills[0]! });
    assert.equal(developed.name, "demo-skill");
    assert.deepEqual(developFetches, ["repo-info", "commit-develop"], "main/master 404 responses trigger default branch discovery");
    assert.equal(await readFile(path.join(developHome, ".config", "biny", "skills", "demo-skill", "SKILL.md"), "utf8"), "---\nname: demo-skill\ndescription: Demo\n---\n\n# Demo\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

await main();
