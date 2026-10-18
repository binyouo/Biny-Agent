import { IdentityStorage } from "../src/agent/context/identityStorage.js";
import { TravelStorage } from "../src/agent/context/travel.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { EmotionStorage } from "../src/agent/context/emotionStorage.js";
import { renderEmotionPrompt } from "../src/agent/context/emotionPrompt.js";
import { FatigueService } from "../src/agent/context/fatigue.js";
import { SoulStorage } from "../src/agent/context/soulStorage.js";
import type { AgentModel, ModelStreamContext } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("model requests retain complete personality and both mood causes when a custom Soul takes over", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-personality-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "state");
  let agent: AgentSession | undefined;
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.context.memory.useMemories = false;
    config.context.memory.generateMemories = false;
    config.context.identity.enabled = true;
    config.activity.enabled = false;
    config.checkpoints.enabled = false;
    const requests: ModelStreamContext[] = [];
    const model: AgentModel = {
      provider: "test", modelId: "personality",
      async stream(context) {
        requests.push(structuredClone({ ...context, tools: [] }));
        return (async function* () {
          yield { type: "text-delta" as const, text: "嗯，听着呢。" };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      }
    };
    recorder = new SessionRecorder(root, "personality");
    agent = new AgentSession({ workspaceRoot: root, config, model, recorder,
      toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
    await agent.initialize();
    const emotions = new EmotionStorage();
    const updatedAt = new Date().toISOString();
    await emotions.writeBase({ mood: "牵挂", energy: 7, valence: 5, updatedAt, trigger: "BASE_CAUSE：一件悬着的事" });
    await emotions.writeContext(recorder.sessionId, { mood: "宽慰", energy: 7, valence: 7, updatedAt, trigger: "CHAT_CAUSE：收到了好消息" });
    await new FatigueService().change("sleep");
    await agent.runTask("聊两句。", { emotionAnalysis: false });
    const first = requests.at(-1)!;
    assert.match(first.systemPrompt ?? "", /SETUP NEEDED/u);
    assert.match(first.systemPrompt ?? "", /You're not a yes-machine/u);
    assert.match(first.systemPrompt ?? "", /If the joke isn't funny, don't force it/u);
    assert.match(first.systemPrompt ?? "", /do you think React or Vue is better/u);
    const initialContext = JSON.stringify(first.messages);
    assert.match(initialContext, /BASE_CAUSE/u, "the base mood cause must survive alongside the current conversation cause");
    assert.match(initialContext, /CHAT_CAUSE/u);
    assert.match(initialContext, /SLEEPING/u);
    assert.doesNotMatch(first.systemPrompt ?? "", /BASE_CAUSE|CHAT_CAUSE|SLEEPING/u);

    await new TravelStorage().change("go", "京都");
    const identity = new IdentityStorage();
    await identity.saveDocument("user", "---\nname: Think\n---\n# About My Human", (await identity.overview()).revision);
    const soul = new SoulStorage();
    await soul.set("# Soul\n\nCUSTOM_PERSONALITY：安静、温柔，喜欢慢慢聊。");
    await agent.runTask("接着说。", { emotionAnalysis: false });
    const second = requests.at(-1)!;
    assert.doesNotMatch(second.systemPrompt ?? "", /SETUP NEEDED/u, "saved profile ends first-meeting guidance on the next turn");
    assert.match(JSON.stringify(second.messages), /TRAVEL STATUS.*京都/su);
    assert.match(JSON.stringify(second.messages), /SELFIE ALBUM/u);
    assert.doesNotMatch(second.systemPrompt ?? "", /TRAVEL STATUS|SELFIE ALBUM/u, "dynamic life state stays out of the stable prefix");
    assert.match(second.systemPrompt ?? "", /CUSTOM_PERSONALITY/u);
    assert.ok(second.systemPrompt?.includes(soul.path), "the model receives the actual editable Soul path");
    assert.doesNotMatch(second.systemPrompt ?? "", /You're not a yes-machine/u, "the default persona must yield to the user's Soul");
    for (const question of ["Have you developed new interests or opinions?", "Has your communication style shifted subtly?",
      "Have you grown closer to certain topics or people?", "Have you learned something that changed how you see things?"]) {
      assert.ok(second.systemPrompt?.includes(question), `Soul reflection must retain: ${question}`);
    }
    assert.match(second.systemPrompt ?? "", /biny soul append-trait/u);
    assert.match(JSON.stringify(second.messages), /BASE_CAUSE/u);
    assert.match(JSON.stringify(second.messages), /CHAT_CAUSE/u);
  } finally {
    await agent?.close();
    if (!agent) await recorder?.close();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("fatigue instructions retain recovery commands, energy synchronization and sleepy conversation", () => {
  const state = { mood: "cheerful", energy: 7, valence: 7, updatedAt: "", source: "base" as const, fatigue: 0 };
  const awake = renderEmotionPrompt(state);
  for (const command of ["biny sleep", "biny wake", "biny rest", "biny fatigue", "biny emotion set-base"]) {
    assert.ok(awake.includes(command), `awake guidance must expose ${command}`);
  }
  assert.match(awake, /Keep them in sync/u);
  const sleepy = renderEmotionPrompt({ ...state, fatigue: 55 });
  assert.match(sleepy, /Simple conversation is fine but you're clearly low energy/u);
  assert.doesNotMatch(sleepy, /SLEEPING/u);
});
