/** 真实 AgentSession 请求保留原消息，并只注入可读的本地引用正文。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV, projectSessionsDir } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-runtime-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
const workspace = path.join(root, "workspace");
try {
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const directory = projectSessionsDir(workspace);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "source.jsonl"), JSON.stringify({ type: "user_message", messageId: "m1", content: "批准的规格是保留原文" }) + "\n");
  const requests: ModelStreamContext[] = [];
  const model: AgentModel = { provider: "fixture", modelId: "reference-runtime", stream: async (context) => {
    requests.push(context);
    return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "收到" }; yield { type: "finish", reason: "stop" }; })();
  } };
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.activity.enabled = false;
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({ workspaceRoot: workspace, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission), recorder });
  try {
    await agent.initialize();
    const input = "请读 @[规格](biny://thread/source/message/m1)";
    assert.equal((await agent.runTask(input)).status, "completed");
    assert.match(JSON.stringify(requests.at(-1)), /批准的规格是保留原文/u);
    assert.equal((await readSessionEvents(recorder.filePath)).find((event) => event.type === "user_message")?.content, input);
    await agent.runTask("请读 @[伪造](biny://thread/absent/message/m1)");
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /批准的规格是保留原文/u);
  } finally { await agent.close(); }
  console.log("local reference runtime tests passed");
} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV]; else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
}
