/**
 * 技能提取的运行时端到端：真实 CommandRuntime/AgentSession/InteractiveAgentRuntime
 * 跑一个多工具调用的成功回合，仅替换模型协议边界（fake fetch），验证
 * skill_extraction.updated 事件从公开订阅出口发出、技能落盘受管根、session 记录审计 metadata。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

const extractedMarkdown = [
  "---",
  "name: echo-workflow",
  "description: Repeat the staged echo workflow used by this workspace.",
  "allowed-tools:",
  "  - Bash",
  "---",
  "",
  "# Echo workflow",
  "",
  "1. Run the staged echo commands.",
  "2. Report the outputs."
].join("\n");

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-extraction-runtime-"));
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, ".agent-test");
  // 主模型前 5 步跑工具，第 6 步收尾；保证回合内 tool_call 数达到默认阈值 5。
  let mainSteps = 0;
  globalThis.fetch = (async (_input, init): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role?: string; content?: unknown }>;
    };
    const system = textContent(body.messages[0]?.content);
    if (system.includes("tool search assistant")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的工具")) return streamText('{"tools":[]}');
    if (system.includes("选择需要的技能")) return streamText('{"skillIds":[]}');
    if (system.includes("技能提取分析师")) {
      return streamText(JSON.stringify({ worthy: true, skillName: "echo-workflow", skillDescription: "Repeat the staged echo workflow.", reasoning: "reusable", existingSkillToUpdate: null }));
    }
    if (system.includes("技能作者")) return streamText(extractedMarkdown);
    mainSteps += 1;
    if (mainSteps <= 5) return streamToolCall(`echo-${String(mainSteps)}`, "Bash", { command: `echo step-${String(mainSteps)}` });
    return streamText("工作流已执行完成。");
  }) as typeof fetch;

  let runtime: InteractiveAgentRuntime | undefined;
  try {
    const configStore: AgentConfigStore = { load: async () => config(), save: async () => undefined };
    const commands = await createCommandRuntime(root, { configStore });
    runtime = new InteractiveAgentRuntime(commands);
    const extractionEvents: AgentHostEvent[] = [];
    runtime.subscribe((update) => {
      if (update.event?.type === "skill_extraction.updated") extractionEvents.push(update.event);
    });
    const sessionId = commands.agent.getInfo().sessionId;

    const outcome = await runtime.submitPrompt("按既定流程跑一遍 echo 工作流。").completion;
    assert.equal(outcome.status, "completed");

    // 提取在回合终态后 fire-and-forget，用条件轮询等待事件到达公开订阅出口。
    await waitUntil(() => extractionEvents.some((event) => event.type === "skill_extraction.updated" && event.stage === "done"), 15_000);
    assert.deepEqual(
      extractionEvents.map((event) => (event.type === "skill_extraction.updated" ? event.stage : "")),
      ["extracting", "saving", "done"],
      "进度事件必须按序到达 runtime 订阅出口（Desktop/TUI 消费同一出口）"
    );
    const done = extractionEvents.at(-1)!;
    assert.equal(done.type === "skill_extraction.updated" && done.skillName, "echo-workflow");
    assert.equal(done.type === "skill_extraction.updated" && done.updated, false);

    const installedPath = path.join(root, ".agent-test", "skills", "echo-workflow", "SKILL.md");
    assert.match(await readFile(installedPath, "utf8"), /^---\nname: echo-workflow\n/u, "技能必须落盘受管全局根");

    const events = await readSessionEvents(sessionFilePath(root, sessionId));
    const audit = events.filter((event) => event.type === "message_metadata" && event.metadata.skillExtracted !== undefined);
    assert.equal(audit.length, 1, "保存成功后必须留下 skillExtracted 审计 metadata");

    // 刷新链路：下一回合的技能目录必须包含新技能（refreshSkills 已强制重扫）。
    const refreshed = commands.listSkills();
    assert.equal(refreshed.some((skill) => skill.name === "echo-workflow"), true, "提取的技能下一回合即可被发现");
    console.log("skill extraction runtime e2e passed");
  } finally {
    await runtime?.close();
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

function config(): AgentConfig {
  return {
    ...defaultConfig,
    defaultModel: "extraction-test",
    providers: { test: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test-key" } },
    models: {
      "extraction-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "test",
        model: "extraction-test",
        displayName: "Extraction Test"
      }
    },
    permission: { ...defaultConfig.permission, mode: "full-access", criticalAlwaysAsk: false },
    checkpoints: { enabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  };
}

function streamToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return stream([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ]);
}

function streamText(content: string): Response {
  return stream([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]);
}

function stream(parts: unknown[]): Response {
  return new Response([...parts.map((part) => `data: ${JSON.stringify(part)}`), "data: [DONE]"].join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for skill extraction events.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

void main();
