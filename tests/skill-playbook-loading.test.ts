import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillResourceTool, createSkillTool, loadSkills } from "../src/extensions/skills.js";
import { confirmedLoadedSkill } from "../src/desktop/renderer/src/loadedSkills.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-skill-playbook-")));
try {
  const bundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "global") });
  const computer = bundle.skills.find(skill => skill.name === "computer-use");
  assert.ok(computer);
  assert.equal(computer.scope, "builtin");
  const activation = await createSkillTool(bundle).resolveExecution({ skill: "computer-use" });
  assert.ok(!("isError" in activation));
  const instructions = await activation.execute({ toolCallId: "activate", operationId: "activate" });
  assert.equal(typeof instructions, "string");
  assert.match(String(instructions), /read_skill_resource/u);
  assert.ok(String(instructions).includes('skill: "computer-use"'));
  assert.ok(String(instructions).includes("playbooks/NetEaseMusic.md"));
  assert.doesNotMatch(String(instructions), /MUST read them using absolute paths|Remember to use absolute paths|resolve them to absolute paths/u);
  assert.equal(confirmedLoadedSkill({ tool: "Skill", args: { skill: "computer-use" }, result: instructions,
    status: "success", executionStatus: "succeeded" }), "computer-use");

  const reader = createReadFileTool({ workspaceRoot: root, ignore: [] });
  assert.throws(() => reader.resolveExecution({ path: path.join(path.dirname(computer.filePath), "playbooks/NetEaseMusic.md") }), /Path escapes workspace/u);
  const resources = createSkillResourceTool(bundle);
  const resource = await resources.resolveExecution({ skill: "computer-use", path: "playbooks/NetEaseMusic.md" });
  assert.ok(!("isError" in resource));
  const result = await resource.execute({ toolCallId: "playbook", operationId: "playbook" }) as { content: string };
  assert.match(result.content, /^# 网易云音乐/u);
  assert.match(result.content, /com\.netease\.163music/u);
  for (const requested of ["../outside.md", computer.filePath]) {
    assert.ok("isError" in await resources.resolveExecution({ skill: "computer-use", path: requested }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
