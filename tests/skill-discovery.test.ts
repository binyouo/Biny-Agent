import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addSkillRepository,
  discoverSkillRepositories,
  installDiscoveredSkill,
  listSkillRepositories,
  removeSkillRepository,
  searchSkillsSh,
  updateDiscoveredSkill,
  type SkillRepository
} from "../src/extensions/skillDiscovery.js";
import { readManagedSkillVersion, rollbackSkillVersion } from "../src/extensions/skillVersions.js";
import { scanSkillCatalog } from "../src/extensions/skillCatalog.js";
import { loadSkills, skillPromptForSelection } from "../src/extensions/skills.js";
import { writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-discovery-"));
  const homeDir = path.join(root, "home");
  const repository: SkillRepository = { owner: "demo-owner", name: "demo-skills", branch: "main", enabled: true };
  let revision = "a".repeat(40);
  let guide = "# Guide\n";
  const downloadedRevisions: string[] = [];
  const fetcher: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha: revision }));
    if (url.includes("/git/trees/")) {
      return response(JSON.stringify({ tree: [
        { path: "skills/demo/SKILL.md", type: "blob", size: 256 },
        { path: "skills/demo/references/guide.md", type: "blob", size: 256 }
      ] }));
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) downloadedRevisions.push(url.split("/")[5]!);
    if (url.endsWith("/skills/demo/SKILL.md")) return response("---\nname: demo-skill\ndescription: Demo discovery skill\n---\n\n# Demo\n");
    if (url.endsWith("/skills/demo/references/guide.md")) return response(guide);
    if (url.includes("skills.sh/api/search")) return response(JSON.stringify({ query: "demo", count: 1, skills: [{ id: "demo-owner/demo-skills:demo-skill", skillId: "demo-skill", name: "demo-skill", installs: 42, source: "demo-owner/demo-skills" }] }));
    return response("not found", 404);
  };

  try {
    const defaults = await listSkillRepositories(homeDir);
    assert.equal(defaults.repositories.length, 4);
    await addSkillRepository(repository, homeDir);
    assert.equal((await listSkillRepositories(homeDir)).repositories.some((item) => item.owner === repository.owner), true);

    const discovered = await discoverSkillRepositories({ repositories: [repository], fetcher });
    assert.equal(discovered.warnings.length, 0);
    assert.equal(discovered.skills[0]?.directory, "skills/demo");
    assert.equal(discovered.skills[0]?.name, "demo-skill");

    const searched = await searchSkillsSh({ query: "demo", fetcher });
    assert.equal(searched.totalCount, 1);
    assert.equal(searched.skills[0]?.installs, 42);
    assert.equal(searched.skills[0]?.repoOwner, "demo-owner");

    const installed = await installDiscoveredSkill({ skill: discovered.skills[0]!, homeDir, fetcher });
    assert.equal(installed.name, "demo-skill");
    const managedRoot = path.join(homeDir, ".config", "biny", "skills");
    const guidePath = path.join(managedRoot, "demo-skill", "references", "guide.md");
    assert.equal(await readFile(guidePath, "utf8"), "# Guide\n");
    assert.equal(installed.diagnostic.status, "unverified");
    assert.deepEqual(downloadedRevisions.slice(-2), [revision, revision]);
    assert.equal((await scanSkillCatalog({ homeDir })).skills.some((skill) => skill.name === "demo-skill"), true);
    const runtime = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: managedRoot });
    assert.equal(runtime.skills.some((skill) => skill.name === "demo-skill"), true, "受管版本必须被实际 runtime 发现");
    const selectedPrompt = skillPromptForSelection(runtime, ["demo-skill"]);
    assert.match(selectedPrompt, /- "demo-skill": Demo discovery skill/u, "首轮提示词只含选中 Skill 的元数据清单");
    assert.equal(selectedPrompt.includes("# Demo"), false, "渐进式披露：正文只经 Skill 工具加载，不进入 system prompt");
    assert.match(selectedPrompt, /progressive disclosure/u, "清单需说明全文经 Skill 工具按需加载");
    const unchanged = await updateDiscoveredSkill({ name: "demo-skill", expectedVersion: installed.version.id, homeDir, fetcher });
    assert.equal(unchanged.version.id, installed.version.id, "未改变的版本不增加历史");
    revision = "b".repeat(40); guide = "# Updated\n";
    const attempts = await Promise.allSettled([1, 2].map(() => updateDiscoveredSkill({ name: "demo-skill", expectedVersion: installed.version.id, homeDir, fetcher })));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1, "同一版本的并发更新只能发布一次");
    const successful = attempts.find((attempt) => attempt.status === "fulfilled");
    assert.ok(successful?.status === "fulfilled");
    const updated = successful.value;
    assert.equal(updated.version.previous, installed.version.id);
    assert.equal(await readFile(guidePath, "utf8"), guide);
    assert.equal(await readFile(path.join(path.dirname(runtime.skills.find((skill) => skill.name === "demo-skill")!.filePath), "references", "guide.md"), "utf8"), "# Guide\n", "旧调用持有的目录不随更新变化");
    await assert.rejects(updateDiscoveredSkill({ name: "demo-skill", expectedVersion: installed.version.id, homeDir, fetcher }), /变化/);
    await writeFile(guidePath, "personal edits");
    await assert.rejects(rollbackSkillVersion(managedRoot, "demo-skill", updated.version.id), /本地修改/);
    await assert.rejects(updateDiscoveredSkill({ name: "demo-skill", expectedVersion: updated.version.id, homeDir, fetcher }), /本地修改/);
    await writeFile(guidePath, guide);
    await rollbackSkillVersion(managedRoot, "demo-skill", updated.version.id);
    assert.equal(await readFile(guidePath, "utf8"), "# Guide\n");
    assert.equal((await readManagedSkillVersion(managedRoot, "demo-skill"))?.revision, "a".repeat(40));

    await assert.rejects(
      () => installDiscoveredSkill({ skill: discovered.skills[0]!, homeDir, fetcher }),
      /Skill 已安装/
    );
    const aborted = new AbortController(); aborted.abort(new Error("test canceled"));
    await assert.rejects(installDiscoveredSkill({ skill: discovered.skills[0]!, homeDir, fetcher, signal: aborted.signal }), /test canceled/);
    let streamCanceled = false;
    const overflowing: typeof fetch = async (input, init) => String(input).endsWith("/references/guide.md")
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(257)); }, cancel() { streamCanceled = true; } }))
      : fetcher(input, init);
    await assert.rejects(updateDiscoveredSkill({ name: "demo-skill", expectedVersion: installed.version.id, homeDir, fetcher: overflowing }), /超过/);
    assert.equal(streamCanceled, true, "未知长度的大响应必须在越界时中断读取");
    assert.equal((await readManagedSkillVersion(managedRoot, "demo-skill"))?.id, installed.version.id, "下载失败不改变当前版本");
    await removeSkillRepository(repository.owner, repository.name, homeDir);
    assert.equal((await listSkillRepositories(homeDir)).repositories.some((item) => item.owner === repository.owner), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

await main();
