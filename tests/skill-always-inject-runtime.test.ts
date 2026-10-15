import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { loadSkills, skillPromptForSelection, skillNamesForSelection } from "../src/extensions/skills.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ToolRegistry } from "../src/tools/registry.js";

await test("常驻技能进入真实回合提示和已加载清单，明确全关与单项禁用优先", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-always-skill-runtime-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  let agent: AgentSession | undefined;
  try {
    const directory = path.join(root, ".biny", "skills", "always-on");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "---\nname: always-on\ndescription: Runtime fixture.\nalways-inject: true\n---\n\nAlways-on runtime instruction.\n");
    const options = { workspaceRoot: root, projectPaths: [".biny/skills"], globalRoot: path.join(root, "global-skills") };
    let bundle = await loadSkills(options);
    const definition = bundle.skills.find(skill => skill.name === "always-on")!;
    const prompts: string[] = [];
    const model: AgentModel = { provider: "test", modelId: "test", async stream(context) {
      prompts.push(context.systemPrompt ?? "");
      return (async function* () { yield { type: "text-delta" as const, text: "Done" }; yield { type: "finish" as const, reason: "stop" as const }; })();
    } };
    const config = structuredClone(defaultConfig);
    config.context.memory.enabled = false;
    config.context.memory.generateMemories = false;
    config.chat.skillExtraction.enabled = false;
    await ensureAgentDirs(root);
    agent = new AgentSession({ workspaceRoot: root, config, model, recorder: new SessionRecorder(root, "always-skill"),
      permissionManager: new PermissionManager(config.permission), toolRegistry: new ToolRegistry(),
      skillPrompt: selection => skillPromptForSelection(bundle, selection), skillNames: selection => skillNamesForSelection(bundle, selection)
    });
    await agent.initialize();
    const loaded: string[][] = [];
    for (const skills of [[], "none"] as const) {
      for await (const event of agent.prompt("Reply once", { capabilitySelection: { tools: "none", skills: typeof skills === "string" ? skills : [] }, emotionAnalysis: false })) {
        if (event.type === "context.updated") loaded.push(event.context.loadedSkills ?? []);
      }
    }
    assert.match(prompts[0]!, /Always-on runtime instruction/u);
    assert.doesNotMatch(prompts[1]!, /Always-on runtime instruction/u);
    assert.ok(loaded.some(names => names.includes("always-on")));
    assert.deepEqual(loaded.at(-1), []);
    bundle = await loadSkills({ ...options, globalDefaults: { [definition.ref]: false } });
    for await (const _event of agent.prompt("Reply again", { capabilitySelection: { tools: "none", skills: [] }, emotionAnalysis: false })) { /* Drain the real turn. */ }
    assert.doesNotMatch(prompts.at(-1)!, /Always-on runtime instruction/u);
  } finally {
    await agent?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
