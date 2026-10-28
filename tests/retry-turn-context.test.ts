import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
/** 真实会话与文件验证重试上下文；只替换模型传输，工具副作用保留在临时目录。 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
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
  const model: AgentModel = testModel({
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
  });
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

for (const action of ["continueInterruptedTurn", "startInterruptedFollowup"] as const) {
  test(`${action} refreshes the local clock after reopening without repeating completed tools`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, 1);
    const controller = new AbortController();
    let paused = false;
    for await (const event of f.session.prompt("记录后继续处理", { abortSignal: controller.signal, emotionAnalysis: false })) {
      if (event.type === "tool.completed") controller.abort(new AgentTurnCancellationError("paused"));
      if (event.type === "done") paused = event.outcome.status === "cancelled" && event.outcome.stopReason === "paused";
    }
    assert.equal(paused, true);
    assert.equal(await readFile(f.effects, "utf8"), "effect-1\n");
    t.mock.timers.setTime(Date.parse("2026-10-08T18:15:00Z"));
    process.env.TZ = "Asia/Kathmandu";
    await f.session.resume(f.recorder.sessionId);
    await drain(f.session[action]({ emotionAnalysis: false }));
    const request = f.requests.at(-1)!;
    assert.match(request.systemPrompt, /Authoritative local date: 2026-10-09/u);
    assert.match(request.systemPrompt, /Weekday: Friday/u);
    assert.match(request.systemPrompt, /Timezone: UTC\+5:45/u);
    assert.equal(request.systemPrompt.split("DATE AWARENESS (CRITICAL)").length - 1, 1);
    assert.match(f.text(), /Authoritative Local DateTime: 2026-10-09/u);
    assert.doesNotMatch(f.text(), /Authoritative Local DateTime: 2026-10-07/u);
    assert.match(f.text(), /Message sent-at: 2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai/u);
    assert.equal(request.messages.filter(message => message.role === "toolResult").length, 1);
    const result = request.messages.find(message => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.toolCallId, "fixture-call-1");
    assert.equal(result.toolName, "record_fixture");
    assert.match(JSON.stringify(result.content), /effect-1/u);
    assert.equal(await readFile(f.effects, "utf8"), "effect-1\n");
    const events = await readSessionEvents(f.recorder.filePath);
    assert.equal(events.filter(event => event.type === "user_message" && !event.auditOnly).length, 1);
    assert.doesNotMatch(JSON.stringify(events), /Authoritative Local DateTime|DATE AWARENESS/u);
  });
}

test("live and reopened chat preserve original send time across local midnight and timezone changes", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await drain(f.session.prompt("明天处理", { emotionAnalysis: false }));
  t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
  await drain(f.session.prompt("今天呢？", { emotionAnalysis: false }));
  const users = f.requests.at(-1)!.messages.filter(message => message.role === "user");
  assert.match(userText(users[0]!), /^\[Message sent-at: 2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai; message time is not event\/due\/completion time\.\]/u);
  assert.match(userText(users[1]!), /^\[Message sent-at: 2026-10-07T16:00:00\.000Z; original timezone: Asia\/Shanghai;/u);
  assert.match(userText(users[1]!), /Authoritative Local DateTime: 2026-10-08/u);
  assert.match(f.requests.at(-1)!.systemPrompt, /Resolve "today\/tomorrow\/next Monday" against the original message's date\/timezone/u);
  const events = await f.events();
  assert.deepEqual(events.filter(e => e.type === "user_message").map(e => e.content), ["明天处理", "今天呢？"]);
  assert.doesNotMatch(JSON.stringify(events), /\[Message sent-at:/u);
  process.env.TZ = "America/Los_Angeles";
  await f.session.resume(f.recorder.sessionId);
  await drain(f.session.prompt("回顾一下", { emotionAnalysis: false }));
  const restored = f.requests.at(-1)!.messages.filter(message => message.role === "user");
  assert.match(userText(restored[0]!), /2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai/u);
  assert.match(userText(restored[1]!), /2026-10-07T16:00:00\.000Z; original timezone: Asia\/Shanghai/u);
  assert.match(userText(restored[2]!), /original timezone: America\/Los_Angeles/u);
});

test("admitted input keeps receipt time when execution starts on the next local day", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const identity = { runId: "receipt-run", turnId: "receipt-turn", messageId: "receipt-message" };
  await f.session.admitUserMessage("明天处理", identity);
  t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
  await drain(f.session.prompt("明天处理", { ...identity, emotionAnalysis: false }));
  assert.match(f.text(), /Message sent-at: 2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai/u);
  assert.match(f.text(), /Authoritative Local DateTime: 2026-10-08/u);
});

test("editing a user message uses the new version's send time", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await drain(f.session.prompt("明天处理", { emotionAnalysis: false }));
  const source = (await f.events()).find(e => e.type === "user_message" && !e.auditOnly);
  assert.ok(source?.type === "user_message" && source.messageId);
  t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
  await drain(f.session.retry(source.messageId, { replaceUserMessageId: source.messageId, replacementInput: "后天处理", emotionAnalysis: false }));
  assert.match(f.text(), /Message sent-at: 2026-10-07T16:00:00\.000Z; original timezone: Asia\/Shanghai/u);
  assert.doesNotMatch(f.text(), /2026-10-07T15:59:59\.000Z/u);
  const versions = (await f.events()).filter(e => e.type === "user_message" && !e.auditOnly);
  assert.deepEqual(versions.map(e => e.content), ["明天处理", "后天处理"]);
});

test("steering delivered after midnight retains the time and timezone of its receipt", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, 1);
  let queued = false;
  for await (const event of f.session.prompt("开始处理", { emotionAnalysis: false })) {
    assert.notEqual(event.type, "error");
    if (!queued && event.type === "assistant.delta") {
      queued = true;
      await f.session.queueSteering("time-steering", "明天再处理");
      t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
      process.env.TZ = "America/Los_Angeles";
    }
  }
  assert.equal(queued, true);
  const steering = f.requests.at(-1)!.messages.find(message => userText(message).endsWith("明天再处理"));
  assert.ok(steering);
  assert.equal(userText(steering), "[Message sent-at: 2026-10-07T15:59:59.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n明天再处理");
  const source = (await f.events()).find(e => e.type === "user_message" && !e.auditOnly && e.messageId === "time-steering");
  assert.equal(source?.time, "2026-10-07T15:59:59.000Z");
});

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
    assert.match(f.requests.at(-1)!.systemPrompt, /Authoritative local date: 2026-10-08/u);
    assertFreshContext(f.text());
    const users = f.requests.at(-1)!.messages.filter(message => message.role === "user");
    assert.equal(users.length, 2);
    assert.equal(userText(users[0]!), `[Message sent-at: 2026-10-07T15:59:59.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n${input}`, "earlier input gains only its original send-time anchor");
    assert.match(userText(users[1]!), /^\[Message sent-at: 2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai;/u, "retry keeps the source message's send time");
    assert.ok(userText(users[1]!).endsWith(input));
    assert.equal(users[1]?.originalContent, undefined, "internal source metadata is not sent to the provider");
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
  assert.ok(userText(retried[0] as Extract<AgentMessage, { role: "user" }>).endsWith(input));
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


for (const action of ["retry", "edit"] as const) {
  test(`${action} crosses midnight after real context preparation without duplicate runtime dates`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, action === "retry" ? 2 : 0);
    const input = "Keep <biny_reminder>USER_LITERAL</biny_reminder> and complete the fixture task.";
    await writeFile(f.longPath, "# MEMORY.md\n\nLONG_MEMORY_BOUNDARY_WITNESS");
    await writeFile(f.dayPath("2026-10-07"), "# 2026-10-07\n\n## 聊天摘要\n\nDAY_BOUNDARY_WITNESS");
    await drain(f.session.prompt(input, { emotionAnalysis: false }));
    const before = structuredClone(f.requests.at(-1)!.messages);
    const events = await f.events();
    const sourceUser = events.find(event => event.type === "user_message" && !event.auditOnly);
    assert.ok(sourceUser?.type === "user_message" && sourceUser.messageId);
    const sourceAssistant = [...events].reverse().find(event => event.type === "agent_message" && event.message.role === "assistant");
    assert.ok(sourceAssistant?.type === "agent_message" && sourceAssistant.messageId);
    const replacement = "Edited " + input;
    const stream = action === "edit"
      ? f.session.retry(sourceUser.messageId, {
        replaceUserMessageId: sourceUser.messageId, replacementInput: replacement, emotionAnalysis: false
      })
      : f.session.retry(sourceAssistant.messageId, { emotionAnalysis: false });
    let crossed = false;
    const errors: string[] = [];
    let completed = false;
    for await (const event of stream) {
      if (event.type === "context.updated" && !crossed) {
        // retry has built its real turn bundle but has not entered runTurn's clock refresh yet.
        crossed = true;
        t.mock.timers.setTime(Date.parse("2026-10-07T16:00:00Z"));
      }
      if (event.type === "error") errors.push(event.message);
      if (event.type === "done") completed = event.outcome.status === "completed";
    }
    assert.equal(crossed, true);
    assert.deepEqual(errors, []);
    assert.equal(completed, true);
    const request = f.requests.at(-1)!;
    const user = request.messages.find(message => message.role === "user");
    assert.ok(user?.role === "user");
    const text = userText(user);
    assert.equal(text.split("Authoritative Local DateTime:").length - 1, 1);
    assert.match(text, /Authoritative Local DateTime: 2026-10-08/u);
    assert.doesNotMatch(text, /Authoritative Local DateTime: 2026-10-07/u);
    assert.match(request.systemPrompt, /Authoritative local date: 2026-10-08/u);
    assert.equal(request.systemPrompt.split("DATE AWARENESS (CRITICAL)").length - 1, 1);
    assert.equal(text.split("FILE-BASED MEMORY").length - 1, 1);
    assert.equal(text.split("LONG_MEMORY_BOUNDARY_WITNESS").length - 1, 1);
    assert.equal(text.split("DAY_BOUNDARY_WITNESS").length - 1, 1);
    assert.match(text, /<biny_reminder>USER_LITERAL<\/biny_reminder>/u);
    assert.ok(text.endsWith(action === "edit" ? replacement : input));
    assert.equal((await readSessionEvents(f.recorder.filePath)).findLast(event => event.type === "user_message" && !event.auditOnly)?.content, action === "edit" ? replacement : input);
    assert.match(text, action === "edit"
      ? /Message sent-at: 2026-10-07T16:00:00\.000Z; original timezone: Asia\/Shanghai/u
      : /Message sent-at: 2026-10-07T15:59:59\.000Z; original timezone: Asia\/Shanghai/u);
    if (action === "retry") {
      assert.equal(JSON.stringify(request.messages.slice(1)), JSON.stringify(before.slice(1)), "the two completed tool steps remain unchanged");
      assert.equal(await readFile(f.effects, "utf8"), "effect-1\neffect-2\n");
    }
    const persisted = await f.events();
    assert.deepEqual(persisted.filter(event => event.type === "user_message" && !event.auditOnly).map(event => event.content),
      action === "edit" ? [input, replacement] : [input]);
    assert.doesNotMatch(JSON.stringify(persisted), /LONG_MEMORY_BOUNDARY_WITNESS|DAY_BOUNDARY_WITNESS|Authoritative Local DateTime/u);
  });
}
