/** 有界远程响应中的所有 Skill 均进入目录，不另按发现数量丢弃条目。 */
import assert from "node:assert/strict";
import { discoverSkillRepositories } from "../src/extensions/skillDiscovery.js";
const names = Array.from({ length: 520 }, (_, index) => `fixture-${String(index).padStart(3, "0")}`);
const fetcher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: names.map((name) => ({ path: `${name}/SKILL.md`, type: "blob" })) }));
  const name = url.split("/").at(-2)!;
  return new Response(`---\nname: ${name}\ndescription: Remote inventory\n---\nBody`);
};
const result = await discoverSkillRepositories({ repositories: [{ owner: "fixture", name: "skills", branch: "main", enabled: true }], fetcher });
assert.deepEqual(result.warnings, []);
assert.deepEqual(result.skills.map((skill) => skill.name).sort(), names);
console.log("complete remote Skill discovery tests passed");
