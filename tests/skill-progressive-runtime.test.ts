import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

for (const alwaysInject of [false, true]) for (const executionMode of ["direct", "code_mode"] as const) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-progressive-skill-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let runtime: CommandRuntime | undefined;
  let phase: "activate" | "continue" | "explicit" | "manual" | "all" | "none" = "activate";
  let mainSteps = 0;
  let selectionRequests = 0;
  const failures: unknown[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let delta: Record<string, unknown>;
      let reason = "stop";
      const system = body.messages.filter((message: { role: string }) => message.role === "system").map((message: { content: unknown }) => String(message.content)).join("\n");
      if (body.model === "selector") {
        if (system.includes("技能目录：")) {
          selectionRequests++;
          assert.match(system, /Progressive routing fixture/u);
          assert.doesNotMatch(system, /PRIVATE_SKILL_BODY|PRIVATE_REFERENCE_BODY/u);
        }
        delta = { content: alwaysInject || phase === "continue" ? '{"skillIds":[],"tools":[]}' : '{"skillIds":["progressive-demo"],"tools":[]}' };
      } else if (body.model !== "chat" || !Array.isArray(body.tools)) {
        delta = { content: "Done" };
      } else {
        assert.doesNotMatch(system, /PRIVATE_SKILL_BODY|UNSELECTED_SKILL_BODY|PRIVATE_REFERENCE_BODY/u,
          "all Skill bodies and resources must stay out of the system prompt even when always selected");
        if (phase === "none" || (phase === "manual" && !alwaysInject)) {
          assert.doesNotMatch(system, /Progressive routing fixture|Other routing fixture/u);
        } else {
          assert.match(system, /<available_skills>[\s\S]*progressive-demo[\s\S]*Progressive routing fixture/u);
          if (phase === "all") assert.match(system, /Other routing fixture/u);
          else assert.doesNotMatch(system, /Other routing fixture/u);
        }
        const toolCall = (name: string, args: Record<string, unknown>) => {
          reason = "tool_calls";
          return { tool_calls: [{ index: 0, id: `load-${mainSteps}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
        };
        if (phase !== "activate") delta = { content: "Metadata inspected." };
        else if (mainSteps === 0) {
          assert.doesNotMatch(JSON.stringify(body.messages), /PRIVATE_SKILL_BODY|PRIVATE_REFERENCE_BODY/u);
          assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === "Skill"));
          if (executionMode === "direct") assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === "KillShell"), "skill declaration supplies the tool without selector help");
          delta = toolCall("Skill", { skill: "progressive-demo" });
        } else if (mainSteps === 1) {
          const result = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool"));
          assert.match(result, /PRIVATE_SKILL_BODY/u);
          assert.match(result, /references\/guide.md/u);
          assert.doesNotMatch(result, /PRIVATE_REFERENCE_BODY/u, "loading instructions must only list resource paths");
          const args = { skill: "progressive-demo", path: "references/guide.md" };
          delta = executionMode === "direct" ? toolCall("read_skill_resource", args)
            : toolCall("run_script", { description: "Run fixture workflow", code: `return await tools.read_skill_resource(${JSON.stringify(args)});` });
        } else {
          assert.equal(mainSteps, 2, "the fixture must finish after one instruction read and one resource read");
          assert.match(JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "tool")), /PRIVATE_REFERENCE_BODY/u);
          delta = { content: "Instructions and resource loaded on demand." };
        }
        mainSteps++;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: reason }] }]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end("Fixture assertion failed");
    }
  });
  try {
    for (const [name, description, instruction] of [
      ["progressive-demo", "Progressive routing fixture", "PRIVATE_SKILL_BODY"],
      ["other-demo", "Other routing fixture", "UNSELECTED_SKILL_BODY"]
    ]) {
      const directory = path.join(root, ".agents", "skills", name!);
      await mkdir(path.join(directory, "references"), { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nallowed-tools: [Bash, KillShell]\nalways-inject: ${alwaysInject && name === "progressive-demo"}\n---\n${instruction}\n`);
      await writeFile(path.join(directory, "references", "guide.md"), "PRIVATE_REFERENCE_BODY");
    }
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const config = configSchema.parse({
      ...defaultConfig, agent: { ...defaultConfig.agent, toolExecutionMode: executionMode },
      defaultModel: "chat", toolModel: "selector",
      providers: { fixture: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
      models: {
        chat: { provider: "fixture", model: "chat", capabilities: { tools: true, reasoning: false, streaming: true } },
        selector: { provider: "fixture", model: "selector", capabilities: { tools: false, reasoning: false, streaming: true } }
      },
      thinking: { ...defaultConfig.thinking, enabled: false },
      chat: { ...defaultConfig.chat, skillExtraction: { ...defaultConfig.chat.skillExtraction, enabled: false } },
      permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
      extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      checkpoints: { enabled: false },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    runtime = await createCommandRuntime(root, { configStore: { load: async () => config, save: async () => undefined } });
    const fixtureSkillId = runtime.extensionStatus().skills.find((skill) => skill.name === "progressive-demo")?.id;
    assert.ok(fixtureSkillId);
    const sessionFile = runtime.agent.getInfo().sessionFile;
    await writeFile(path.join(root, ".agents", "skills", "progressive-demo", "SKILL.md"),
      `---\nname: progressive-demo\ndescription: Progressive routing fixture\nallowed-tools: [Bash, KillShell]\nalways-inject: ${alwaysInject}\n---\nNEW_INSTRUCTIONS_AFTER_SCAN\n`);
    for (const current of ["activate", "continue", "explicit", "manual", "all", "none"] as const) {
      phase = current;
      let status: string | undefined;
      let contextUpdates = 0;
      let selectionUpdates = 0;
      const expectsSelection = current === "activate" || current === "continue" || current === "explicit" || (current === "manual" && alwaysInject);
      for await (const event of runtime.agent.prompt(current === "explicit" ? "/skill:progressive-demo inspect the workflow" : "Inspect the workflow", {
        emotionAnalysis: false, abortSignal: AbortSignal.timeout(15_000),
        capabilitySelection: { tools: "auto", skills: current === "activate" || current === "continue" || current === "explicit" ? "auto" : current === "manual" ? [] : current }
      })) {
        if (event.type === "done") status = event.outcome.status;
        if (event.type === "context.updated") {
          contextUpdates++;
          assert.ok(!event.context.loadedSkills?.includes("progressive-demo"), "metadata disclosure is not a loaded instruction body");
          if (expectsSelection && event.context.capabilitySelection) {
            const selection = event.context.capabilitySelection?.skills;
            assert.ok(Array.isArray(selection) && selection.includes(fixtureSkillId), "selected skill names must remain visible, including always-selected skills when the selector returns no matches");
            selectionUpdates++;
          }
        }
      }
      assert.deepEqual(failures, [], `${executionMode}: model-facing prompt assertions`);
      assert.equal(status, "completed");
      assert.ok(contextUpdates >= 1);
      if (expectsSelection) assert.ok(selectionUpdates >= 1);
    }
    assert.ok(selectionRequests >= 1, "automatic selection must exercise the real auxiliary model path");
    assert.equal(mainSteps, 8);
    await runtime.close();
    runtime = undefined;
    const events = await readSessionEvents(sessionFile);
    const preparation = events.filter((event) => event.type === "message_metadata" && Array.isArray(event.metadata.loadedSkills));
    assert.deepEqual(preparation, [], "metadata-only preparation must not persist any loaded instruction names");
    assert.equal(events.filter((event) => event.type === "tool_call" && event.tool === "Skill").length, 1);
    const turns = buildSessionTimeline(events, []);
    assert.ok(turns[0]?.skills?.includes("progressive-demo"), "successful Skill results remain visible as loaded instructions");
    assert.ok(!turns[1]?.skills?.includes("progressive-demo"), "explicit naming alone must not claim an instruction read");
  } finally {
    await runtime?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
