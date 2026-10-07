/** 真实会话与文件验证重试上下文；只替换模型传输，工具副作用保留在临时目录。 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const answer: ModelStreamEvent[] = [{ type: "text-delta", text: "fixture answer" }, { type: "finish", reason: "stop" }];

async function fixture(t: TestContext, toolSteps = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-turn-context-"));
  const previousRoot = process.env[BINY_AGENT_DIR_ENV];
  const previousZone = process.env.TZ;
  const globalRoot = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  process.env[BINY_AGENT_DIR_ENV] = globalRoot;
  process.env.TZ = "Asia/Shanghai";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-07T15:59:59Z") });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  let session: AgentSession | undefined = undefined;
  t.after(async () => {
    await session?.close();
    if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV]; else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
    if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(globalRoot, "memory"), { recursive: true });
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.permission.mode = "full-access";
  const requests: Array<{ systemPrompt: string; messages: AgentMessage[] }> = [];
  const registry = new ToolRegistry();
  const effects = path.join(root, "effects.txt");
  const effectSchema = z.object({ label: z.string() });
  registry.register({
    name: "record_fixture", description: "Append a synthetic record", risk: "write",
    parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    schema: effectSchema,
    resolveExecution: (raw) => {
      const args = effectSchema.parse(raw);
      return { approvalRule: "record_fixture", retrySafety: "unsafe", execute: async () => {
        await appendFile(effects, `${args.label}\n`);
        return { recorded: args.label };
      } };
    }
  });
  const model: AgentModel = {
    provider: "fixture", modelId: "retry-turn-context", runtime: "builtin-llama.cpp", dataResidency: "local", supportsTools: true,
    stream: async (context, options) => {
      assert.equal(options?.requestContext?.operation, "agent");
      requests.push({ systemPrompt: context.systemPrompt ?? "", messages: structuredClone(context.messages) });
      const step = requests.length;
      const response: ModelStreamEvent[] = step <= toolSteps
        ? [{ type: "text-delta", text: `intermediate ${step}` },
          { type: "tool-call", id: `fixture-call-${step}`, name: "record_fixture", arguments: { label: `effect-${step}` } },
          { type: "finish", reason: "tool-calls" }]
        : answer;
      return (async function* () { yield* response; })();
    }
  };
  const recorder = new SessionRecorder(workspace);
  session = new AgentSession({ workspaceRoot: workspace, config, model, recorder, toolRegistry: registry,
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }) });
  await session.initialize();
  return {
    session, recorder, requests, effects,
    longPath: path.join(globalRoot, "MEMORY.md"),
    dayPath: (day: string) => path.join(globalRoot, "memory", `${day}.md`),
    text: () => JSON.stringify(requests.at(-1)?.messages),
    async events() { await recorder.flush(); return await readSessionEvents(recorder.filePath); }
  };
}

async function drain(stream: AsyncGenerator<AgentSessionEvent>): Promise<void> {
  const errors: string[] = [];
  let completed = false;
  for await (const event of stream) {
    if (event.type === "error") errors.push(event.message);
    if (event.type === "done") completed = event.outcome.status === "completed";
  }
  assert.deepEqual(errors, []);
  assert.equal(completed, true);
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
}

function assertFreshContext(text: string): void {
  assert.match(text, /LONG_NOTE_CURRENT/u, "fresh file memory must reach the actual retry provider request");
  assert.match(text, /Authoritative Local DateTime: 2026-10-08/u);
  assert.match(text, /Today's Notes \(2026-10-08\)/u);
  assert.match(text, /Yesterday's Notes \(2026-10-07\)/u);
  assert.match(text, /DAY_EIGHT_CURRENT/u);
  assert.match(text, /DAY_SEVEN_CURRENT/u);
  assert.doesNotMatch(text, /LONG_NOTE_ORIGINAL|DAY_SIX_OLD/u);
  assert.equal(text.split("FILE-BASED MEMORY").length - 1, 1);
}

for (const targetRole of ["assistant", "user"] as const) {
  test(`${targetRole}-target retry includes current file memory and local date without duplicating or persisting user context`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    await writeFile(f.longPath, "# MEMORY.md\n\nLONG_NOTE_ORIGINAL");
    await writeFile(f.dayPath("2026-10-06"), "# 2026-10-06\n\n## 聊天摘要\n\nDAY_SIX_OLD");
    await writeFile(f.dayPath("2026-10-07"), "# 2026-10-07\n\n## 聊天摘要\n\nDAY_SEVEN_CURRENT");
    const input = "Keep this exact user text.\n第二行";
    await drain(f.session.prompt(input, { emotionAnalysis: false }));
    await drain(f.session.prompt(input, { emotionAnalysis: false }));
    assert.match(f.text(), /LONG_NOTE_ORIGINAL/u);
    assert.match(f.text(), /DAY_SIX_OLD/u);
    const initial = await f.events();
    const target = [...initial].reverse().find(e => targetRole === "assistant" ? e.type === "agent_message" && e.message.role === "assistant" : e.type === "user_message");
    assert.ok(target && "messageId" in target && target.messageId);
    await writeFile(f.longPath, "# MEMORY.md\n\nLONG_NOTE_CURRENT");
    await writeFile(f.dayPath("2026-10-08"), "# 2026-10-08\n\n## 聊天摘要\n\nDAY_EIGHT_CURRENT");
    t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
    await drain(f.session.retry(target.messageId, { emotionAnalysis: false }));
    assert.equal(f.requests.length, 3);
    assertFreshContext(f.text());
    const users = f.requests.at(-1)!.messages.filter(message => message.role === "user");
    assert.equal(users.length, 2);
    assert.equal(userText(users[0]!), input, "earlier identical input remains canonical history");
    assert.ok(userText(users[1]!).endsWith(input));
    assert.deepEqual(users[1]?.originalContent, input);
    const persisted = await f.events();
    assert.deepEqual(persisted.filter(e => e.type === "user_message").map(e => e.content), [input, input]);
    assert.doesNotMatch(JSON.stringify(persisted), /LONG_NOTE_|DAY_(SIX|SEVEN|EIGHT)_|Authoritative Local DateTime/u);
    assert.doesNotMatch(f.requests.at(-1)!.systemPrompt, /LONG_NOTE_/u);
  });
}

test("retrying the final assistant after tool steps refreshes the source user in place and retains completed tool evidence", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, 2);
  const input = "Record two fixture effects and summarize.";
  await writeFile(f.longPath, "# MEMORY.md\n\nLONG_NOTE_ORIGINAL");
  await drain(f.session.prompt(input, { emotionAnalysis: false }));
  assert.equal(f.requests.length, 3);
  assert.equal(await readFile(f.effects, "utf8"), "effect-1\neffect-2\n");
  const originalRequest = f.requests.at(-1)!.messages;
  assert.deepEqual(originalRequest.map(message => message.role), ["user", "assistant", "toolResult", "assistant", "toolResult"]);
  const target = [...await f.events()].reverse().find(e => e.type === "agent_message" && e.message.role === "assistant");
  assert.ok(target?.type === "agent_message" && target.messageId);
  await writeFile(f.longPath, "# MEMORY.md\n\nLONG_NOTE_CURRENT");
  await drain(f.session.retry(target.messageId, { emotionAnalysis: false }));
  const retried = f.requests.at(-1)!.messages;
  assert.match(f.text(), /LONG_NOTE_CURRENT/u);
  assert.doesNotMatch(f.text(), /LONG_NOTE_ORIGINAL/u);
  assert.deepEqual(retried.map(message => message.role), ["user", "assistant", "toolResult", "assistant", "toolResult"]);
  assert.equal(JSON.stringify(retried.slice(1)), JSON.stringify(originalRequest.slice(1)), "tool calls, results and intermediate assistant output retain their persisted representation");
  assert.equal(retried[0]?.role === "user" ? retried[0].originalContent : undefined, input);
  assert.equal(await readFile(f.effects, "utf8"), "effect-1\neffect-2\n", "retry must not replay either completed side effect");
  const persisted = await f.events();
  assert.equal(persisted.filter(e => e.type === "user_message").length, 1);
  assert.doesNotMatch(JSON.stringify(persisted), /LONG_NOTE_|Authoritative Local DateTime/u);
});

test("successive ordinary turns read same-size same-mtime edits, deletion and local-midnight rotation", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const yesterday = f.dayPath("2026-10-06");
  const today = f.dayPath("2026-10-07");
  const stamp = new Date("2026-10-01T00:00:00Z");
  await writeFile(f.longPath, "LONG_NOTE_A");
  await writeFile(today, "# 2026-10-07\n\n## 聊天摘要\n\nDAY_SEVEN_A");
  await writeFile(yesterday, "# 2026-10-06\n\n## 聊天摘要\n\nDAY_SIX_A");
  for (const file of [f.longPath, today, yesterday]) await utimes(file, stamp, stamp);
  await drain(f.session.prompt("first", { emotionAnalysis: false }));
  assert.match(f.text(), /LONG_NOTE_A/u);
  for (const file of [f.longPath, today, yesterday]) {
    const before = await stat(file);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("_A", "_B"));
    await utimes(file, stamp, stamp);
    const after = await stat(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  }
  await drain(f.session.prompt("second", { emotionAnalysis: false }));
  assert.match(f.text(), /LONG_NOTE_B/u);
  assert.match(f.text(), /DAY_SEVEN_B/u);
  assert.match(f.text(), /DAY_SIX_B/u);
  assert.doesNotMatch(f.text(), /LONG_NOTE_A|DAY_SEVEN_A|DAY_SIX_A/u);
  await rm(f.longPath);
  await rm(today);
  await drain(f.session.prompt("third", { emotionAnalysis: false }));
  assert.match(f.text(), /DAY_SIX_B/u);
  assert.doesNotMatch(f.text(), /LONG_NOTE_|DAY_SEVEN_|Today's Notes/u);
  await writeFile(f.longPath, "LONG_NOTE_CURRENT");
  await writeFile(today, "# 2026-10-07\n\n## 聊天摘要\n\nDAY_SEVEN_CURRENT");
  await writeFile(f.dayPath("2026-10-08"), "# 2026-10-08\n\n## 聊天摘要\n\nDAY_EIGHT_CURRENT");
  t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
  await drain(f.session.prompt("fourth", { emotionAnalysis: false }));
  assertFreshContext(f.text());
  assert.doesNotMatch(f.text(), /DAY_SIX_B/u);
});
