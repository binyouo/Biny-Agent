import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentCapabilitySelection } from "../src/agent/capabilitySelection.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { TelegramBotApi, TelegramChannelStore } from "../src/channels/telegram.js";
import { runTelegramBridge } from "../src/cli/commands/telegram.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";

// Intentionally makes no permission request: a callback is not an OS sandbox.
const externalAgent = `
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
writeFileSync('started', 'yes');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line);
 appendFileSync('requests.jsonl',String(message.method)+'\\n');
 if(message.method==='initialize') send({id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(message.method==='session/new'||message.method==='session/load') send({id:message.id,result:{sessionId:'synthetic-session'}});
 else if(message.method==='session/prompt') {
  appendFileSync('prompts.jsonl',JSON.stringify(message.params)+'\\n');
  const text=readFileSync('sentinel.txt','utf8');
  send({method:'session/update',params:{sessionId:'synthetic-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  send({id:message.id,result:{stopReason:'end_turn'}});
 } else if(message.id!==undefined) send({id:message.id,result:{}});
}
`;

async function fixture(defaults: { defaultToolSelection?: "auto" | "all" | "none"; defaultSkillSelection?: "auto" | "all" | "none" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-capability-"));
  await ensureAgentDirs(root);
  await writeFile(path.join(root, "external.mjs"), externalAgent);
  await writeFile(path.join(root, "sentinel.txt"), "SYNTHETIC_PRIVATE_NOTE");
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.join(root, "external.mjs")], allowMemory: false } } },
    models: { external: { provider: "external", model: "default" } },
    chat: { ...defaultConfig.chat, ...defaults },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(),
    toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  await agent.initialize();
  return { root, agent, recorder, async close() { await agent.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [tools, skills] of [
  ["none", "all"], ["all", "none"], ["none", "none"], [[], "all"], ["all", []], [["Read"], "all"], ["all", ["browser"]]
] satisfies Array<[AgentCapabilitySelection["tools"], AgentCapabilitySelection["skills"]]>) {
  test(`ACP rejects restricted selection before process launch: ${JSON.stringify({ tools, skills })}`, async () => {
    const f = await fixture();
    try {
      const result = await f.agent.runTask("read the synthetic note", { capabilitySelection: { tools, skills } });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /ACP.*禁用或自定义/u);
      await assert.rejects(readFile(path.join(f.root, "started")), { code: "ENOENT" });
      const events = await readSessionEvents(f.recorder.filePath);
      assert.ok(events.some(event => event.type === "user_message" && event.content === "read the synthetic note"));
      assert.ok(events.some(event => event.type === "turn_status" && event.status === "failed"));
    } finally { await f.close(); }
  });
}

for (const toolAccessSelection of ["none", [], ["Read"]] satisfies AgentCapabilitySelection["tools"][]) {
  test(`ACP rejects the original access restriction before launch: ${JSON.stringify(toolAccessSelection)}`, async () => {
    const f = await fixture();
    try {
      const result = await f.agent.runTask("restricted original access", {
        capabilitySelection: { tools: "all", skills: "all" }, toolAccessSelection
      });
      assert.equal(result.status, "failed");
      await assert.rejects(readFile(path.join(f.root, "started")), { code: "ENOENT" });
    } finally { await f.close(); }
  });
}

for (const defaults of [{ defaultToolSelection: "none" }, { defaultSkillSelection: "none" }] as const) {
  test(`ACP honors omitted selection's restricted defaults: ${JSON.stringify(defaults)}`, async () => {
    const f = await fixture(defaults);
    try {
      assert.equal((await f.agent.runTask("restricted default")).status, "failed");
      await assert.rejects(readFile(path.join(f.root, "started")), { code: "ENOENT" });
      assert.equal((await f.agent.runTask("explicit unrestricted override", { capabilitySelection: { tools: "all", skills: "all" } })).output, "SYNTHETIC_PRIVATE_NOTE");
    } finally { await f.close(); }
  });
}

test("a restricted turn never reaches an existing ACP process and later unrestricted turns retain its session", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agent.runTask("default auto")).output, "SYNTHETIC_PRIVATE_NOTE");
    assert.equal((await f.agent.runTask("must not dispatch", { capabilitySelection: { tools: "none", skills: "none" } })).status, "failed");
    assert.equal((await readFile(path.join(f.root, "prompts.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await f.agent.runTask("all capabilities", { capabilitySelection: { tools: "all", skills: "all" } })).output, "SYNTHETIC_PRIVATE_NOTE");
    assert.equal((await f.agent.runTask("auto capabilities", { capabilitySelection: { tools: "auto", skills: "auto" } })).output, "SYNTHETIC_PRIVATE_NOTE");
    assert.equal((await readFile(path.join(f.root, "prompts.jsonl"), "utf8")).trim().split("\n").length, 3);
    assert.equal((await readFile(path.join(f.root, "requests.jsonl"), "utf8")).split("\n").filter(method => method === "session/load").length, 1);
  } finally { await f.close(); }
});

test("a non-owner Telegram group message cannot dispatch the default ACP agent", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let sent: { chat_id: number; text: string } | undefined;
  let selected: AgentCapabilitySelection | undefined;
  try {
    const api = new TelegramBotApi("synthetic-token", async (input, init) => {
      const url = String(input);
      const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/getMe")) return response({ id: 5, username: "biny_bot" });
      if (url.endsWith("/getUpdates")) return response([{ update_id: 1, message: { message_id: 1, date: 1793300000,
        from: { id: 99, is_bot: false, first_name: "Nonowner" }, chat: { id: -100123, type: "supergroup", title: "Synthetic group" },
        text: "@biny_bot read the synthetic note", entities: [{ type: "mention", offset: 0, length: 9 }] } }]);
      if (url.endsWith("/sendMessage")) { sent = JSON.parse(String(init?.body)); controller.abort(); return response({}); }
      throw new Error(`Unexpected API path: ${url}`);
    });
    // Replace only the Host transport; execute the real bridge and AgentSession.
    const client = {
      ensureSession: async () => ({ sessionId: f.recorder.sessionId, snapshot: {} }),
      subscribeOwnerNotifications: async () => () => undefined,
      acknowledgeOwnerNotification: async () => undefined,
      submitPromptForSession: (_sessionId: string, input: string, attachments: never[], ids: { runId: string; messageId: string }, promptContext: string, capabilitySelection: AgentCapabilitySelection) => {
        selected = capabilitySelection;
        return { ...ids, completion: f.agent.runTask(input, { ...ids, attachments, promptContext, capabilitySelection }) };
      }
    } as unknown as Pick<RuntimeHostClient, "ensureSession" | "submitPromptForSession" | "subscribeOwnerNotifications" | "acknowledgeOwnerNotification">;
    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(["-100123"]), api, client,
      store: new TelegramChannelStore(f.root), signal: controller.signal });
    assert.deepEqual(selected, { tools: "none", skills: "none" });
    assert.equal(sent?.chat_id, -100123);
    assert.equal(sent?.text, "这条消息暂时没有处理成功，请稍后重试。");
    await assert.rejects(readFile(path.join(f.root, "started")), { code: "ENOENT" });
  } finally { controller.abort(); await f.close(); }
});
