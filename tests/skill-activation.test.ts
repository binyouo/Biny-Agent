import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillTool, loadSkills, skillPromptForSelection, skillNamesForSelection, skillPathsForSelection } from "../src/extensions/skills.js";
import { resolveSkillActivation, setSkillActivation } from "../src/extensions/skillActivation.js";
import { createSkillRef } from "../src/extensions/skillRef.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-activation-"));
  try {
    const skillDirectory = path.join(workspaceRoot, ".biny", "skills", "demo-skill");
    const globalRoot = path.join(workspaceRoot, "global-skills");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: demo-skill\ndescription: A test skill.\n---\n\nUse the test skill.\n", "utf8");

    const ref = createSkillRef({ scope: "project", name: "demo-skill", projectRoot: await realpath(workspaceRoot), source: "biny" });
    assert.deepEqual(resolveSkillActivation({ ref }), {
      enabled: true,
      globalEnabled: true,
      projectOverride: undefined,
      source: "default"
    });
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false } }).enabled, false);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).enabled, true);
    assert.equal(resolveSkillActivation({ ref, globalDefaults: { [ref]: false }, projectOverrides: { [ref]: true } }).source, "project");
    assert.deepEqual(setSkillActivation({ [ref]: false }, ref, undefined), {});

    const disabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false }
    });
    assert.deepEqual(disabled.skills.filter((skill) => skill.name === "demo-skill").map((skill) => skill.ref), [], JSON.stringify({ expectedRef: ref, actual: disabled.skills.map((skill) => skill.ref) }));
    assert.equal(disabled.prompt.includes("demo-skill"), false);

    const projectEnabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot,
      globalDefaults: { [ref]: false },
      projectOverrides: { [ref]: true }
    });
    assert.deepEqual(projectEnabled.skills.filter((skill) => skill.name === "demo-skill").map((skill) => skill.ref), [ref]);

    const builtins = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
    const builtinNames = builtins.skills.filter((skill) => skill.scope === "builtin").map((skill) => skill.name);
    assert.deepEqual(builtinNames, ["browser", "computer-use", "daily-report", "file-manager", "memory-management", "notebook", "plan-weave", "scheduler", "self-reflection", "system-info", "tasks", "todo", "web-fetch", "web-search", "workspace-search"]);
    assert.equal(builtins.skills.filter((skill) => skill.scope === "builtin").every((skill) => skill.source === "builtin"), true);
    const report = builtins.skills.find((skill) => skill.name === "daily-report")!;
    assert.equal(report.scope, "builtin");
    const reportExecution = createSkillTool(builtins).resolveExecution({ skill: "daily-report" });
    assert.ok(!("isError" in reportExecution), "日报技能必须能经运行时 Skill 工具加载，不只是源码目录里存在");
    for (const skill of builtins.skills.filter((candidate) => candidate.scope === "builtin")) {
      assert.doesNotMatch(skill.description, /\p{Script=Han}/u, `${skill.name}: built-in catalog descriptions must be English, including routing examples`);
      // 所有新增内置技能必须可经真实 Skill 入口加载；目录枚举无法发现正文读取失败。
      const execution = createSkillTool(builtins).resolveExecution({ skill: skill.name });
      assert.ok(!("isError" in execution), `${skill.name} must resolve through Skill`);
      if (!("isError" in execution)) {
        const instructions = await execution.execute({ toolCallId: `builtin-${skill.name}` });
        assert.equal(typeof instructions, "string");
        assert.match(instructions as string, /\S/u, `${skill.name} must load instructions`);
      }
      const document = await readFile(skill.filePath, "utf8");
      assert.match(document, new RegExp(`name:\\s*${skill.name}\\b`));
      assert.match(document, /description:\s*\S/u);
      assert.match(document, /\n[^-\s].+/u, `${skill.name} must have a non-empty instruction body`);
      assert.doesNotMatch(document, /\b(?:claude|codex|pi|alma|maka|anthropic|openai)\b/iu, `${skill.name} must keep Biny's product identity boundary`);
    }

    const overrideDirectory = path.join(workspaceRoot, ".biny", "skills", "memory-management");
    await mkdir(overrideDirectory, { recursive: true });
    await writeFile(path.join(overrideDirectory, "SKILL.md"), "---\nname: memory-management\ndescription: Project override\n---\nProject instructions.\n", "utf8");
    const overridden = await loadSkills({ workspaceRoot, projectPaths: [], globalRoot });
    const projectOverride = overridden.skills.find((skill) => skill.name === "memory-management");
    assert.equal(projectOverride?.scope, "project");
    assert.equal(projectOverride?.source, "biny");
    const overrideExecution = createSkillTool(overridden).resolveExecution({ skill: "memory-management" });
    assert.ok(!("isError" in overrideExecution));
    if (!("isError" in overrideExecution)) {
      assert.match(await overrideExecution.execute({ toolCallId: "override" }) as string, /Project instructions/);
    }

    const disabledOverride = await loadSkills({
      workspaceRoot,
      projectPaths: [],
      globalRoot,
      projectOverrides: { [projectOverride!.ref]: false }
    });
    assert.equal(disabledOverride.skills.some((skill) => skill.name === "memory-management"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** always-inject 的 skill 不依赖能力分析选中，正文每轮进入系统提示。 */
async function alwaysInjectedSkillScope(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-skill-always-inject-"));
  try {
    const skillDirectory = path.join(workspaceRoot, ".biny", "skills", "always-on");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: always-on\ndescription: Always injected skill.\nalways-inject: true\n---\n\nAlways-on body.\n", "utf8");
    const ordinary = path.join(workspaceRoot, ".biny", "skills", "optional");
    await mkdir(ordinary, { recursive: true });
    await writeFile(path.join(ordinary, "SKILL.md"), "---\nname: optional\ndescription: Optional instructions.\n---\n\nOptional body.\n");
    const bundle = await loadSkills({ workspaceRoot, projectPaths: [".biny/skills"], globalRoot: path.join(workspaceRoot, "no-global-skills") });
    const alwaysOn = bundle.skills.find((skill) => skill.name === "always-on");
    assert.equal(alwaysOn?.alwaysInject, true);

    // selection 为空数组时其他 skill 不注入，always-inject 仍然注入。
    const injected = await skillPromptForSelection(bundle, []);
    assert.match(injected, /Always-on body/u, "always-inject 正文必须进入系统提示");
    assert.doesNotMatch(injected, /Optional body/u, "普通 skill 不得在空 selection 下注入");
    // 列表里标注常驻状态，避免模型重复调用 Skill 工具加载。
    assert.match(bundle.prompt, /"always-on" \[always injected\]/u);
    assert.match(bundle.prompt, /do not call the Skill tool for it/u);

    assert.equal(await skillPromptForSelection(bundle, "none"), "", "明确关闭本回合技能时不能由常驻声明重新启用");
    assert.deepEqual(skillNamesForSelection(bundle, "none"), []);
    assert.deepEqual(skillPathsForSelection(bundle, "none"), []);

    // 关闭后不再常驻。
    const disabled = await loadSkills({
      workspaceRoot,
      projectPaths: [".biny/skills"],
      globalRoot: path.join(workspaceRoot, "no-global-skills"),
      globalDefaults: { [alwaysOn!.ref]: false }
    });
    assert.equal(disabled.skills.some((skill) => skill.name === "always-on"), false);
    const disabledInjected = await skillPromptForSelection(disabled, []);
    assert.doesNotMatch(disabledInjected, /Always-on body/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

await main();
await alwaysInjectedSkillScope();
