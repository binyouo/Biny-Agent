/** 后台摘要契约：开启时间、预算、用户意图、手动状态和项目草稿的副作用边界。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../src/agent/core/types.js";
import { ThreadBriefService, type BriefThread } from "../src/session/threadBriefService.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-brief-"));
const now = () => new Date("2026-09-22T00:00:00Z");
const store = new ThreadBriefStore(root, now);
const threads = new Map<string, BriefThread>();
let output: unknown = { topic: "编辑器交付", goal: "上线编辑器", objects: ["Canvas"], conclusions: ["校验通过"], followUp: { what: "发布编辑器", quote: "明天我会发布编辑器" } };
let fail = false;
const model: AgentModel = { provider: "test", modelId: "brief-test", stream: async function* () {
  if (fail) throw new Error("provider disconnected");
  yield { type: "text-delta", text: JSON.stringify(output) };
  yield { type: "finish", reason: "stop" };
} };
const service = new ThreadBriefService({ store, now, readThread: async (id) => threads.get(id), getModel: async () => model });
const makeThread = (id: string, date = "2026-09-23T00:00:00Z"): BriefThread => ({
  sessionId: id, projectId: "workspace", title: "编辑器", createdAt: date,
  messages: [{ role: "user", text: "帮我检查 Canvas" }, { role: "assistant", text: "已检查" }, { role: "user", text: "明天我会发布编辑器" }, { role: "assistant", text: "好的" }]
});

try {
  await service.initialize();
  service.setConfig({ ...store.config(), projectSuggestions: false });
  // Given 开启前的旧对话，When 自动处理，Then 不读模型、不写摘要；显式补写可以处理。
  threads.set("old", makeThread("old", "2026-09-21T00:00:00Z"));
  await service.enqueue("old");
  assert.equal(store.brief("old"), undefined);
  await service.enqueue("old", true);
  assert.equal(store.brief("old")?.status, "todo");
  assert.equal(store.brief("old")?.autoTodo?.quote, "明天我会发布编辑器");
  const previous = store.brief("old");
  fail = true;
  await service.enqueue("old", true);
  assert.deepEqual(store.brief("old"), previous, "相同材料必须复用持久化摘要");
  fail = false;

  // Given 用户手工改回收件箱，When 有新的明确后续意图，Then 不覆盖用户状态。
  store.setStatus("old", "inbox");
  threads.get("old")!.messages.push({ role: "user", text: "稍后我会处理移动端" });
  output = { ...output as object, followUp: { what: "处理移动端", quote: "稍后我会处理移动端" } };
  await service.enqueue("old", true);
  assert.equal(store.brief("old")?.status, "inbox");
  assert.equal(store.brief("old")?.statusManual, true);

  // 模型输出的引用必须能在用户材料中找到，助手承诺不得成为待办。
  threads.set("assistant", { ...makeThread("assistant"), messages: [{ role: "user", text: "现在修复" }, { role: "assistant", text: "明天我会发布编辑器" }] });
  output = { topic: "修复", goal: "", objects: [], conclusions: [], followUp: { what: "发布", quote: "明天我会发布编辑器" } };
  await service.enqueue("assistant", true);
  assert.equal(store.brief("assistant")?.brief.followUp, null);
  assert.equal(store.brief("assistant")?.status, "inbox");
  threads.set("short", { ...makeThread("short"), messages: [{ role: "user", text: "hi" }] });
  await service.enqueue("short");
  assert.equal(store.brief("short"), undefined);
  service.setConfig({ ...store.config(), enabled: false });
  threads.set("disabled", makeThread("disabled"));
  await service.enqueue("disabled");
  assert.equal(store.brief("disabled"), undefined);
  service.setConfig({ ...store.config(), enabled: true });
  threads.set("invalid", makeThread("invalid"));
  output = { surprise: "not a brief" };
  await assert.rejects(service.enqueue("invalid"), /摘要/u);
  assert.equal(store.brief("invalid"), undefined);
  fail = true;
  await assert.rejects(service.enqueue("invalid"), /disconnected/u);
  assert.equal(store.brief("invalid"), undefined);
  fail = false;
  assert.throws(() => service.setConfig({ ...store.config(), minUserTurns: Number.NaN }));
  // 预算只限制自动增量，明确补写可以越过预算；失败不替换上一次有效摘要。
  output = { topic: "预算检查", goal: "", objects: [], conclusions: [], followUp: null };
  threads.set("budget", makeThread("budget"));
  await service.enqueue("budget");
  const budgetBefore = store.brief("budget");
  threads.get("budget")!.messages.push({ role: "user", text: "补充一句" });
  fail = true;
  await service.enqueue("budget");
  assert.deepEqual(store.brief("budget"), budgetBefore);
  await assert.rejects(service.enqueue("budget", true), /disconnected/u);
  assert.deepEqual(store.brief("budget"), budgetBefore);
  fail = false;
  service.setConfig({ ...store.config(), autoTodo: false });
  threads.set("no-auto-todo", makeThread("no-auto-todo"));
  output = { topic: "后续发布", goal: "", objects: [], conclusions: [], followUp: { what: "发布编辑器", quote: "明天我会发布编辑器" } };
  await service.enqueue("no-auto-todo");
  assert.equal(store.brief("no-auto-todo")?.status, "inbox");
  assert.ok(store.brief("no-auto-todo")?.brief.followUp);
  assert.equal(store.snapshot().lastError, undefined, "下一次成功清除已显示的后台错误");
  await service.close();
  await store.open();
  assert.equal(store.brief("old")?.statusManual, true, "重启保留手工状态");
  assert.equal(store.enabledAt(), now().toISOString());
  store.close();
} finally { await service.close(); await rm(root, { recursive: true, force: true }); }

// Given Provider 还没有返回，When 关闭开关，Then 请求被取消，迟到结果不能写入。
const cancellationRoot = await mkdtemp(path.join(os.tmpdir(), "biny-brief-cancel-"));
let started!: () => void;
let finish!: () => void;
const waiting = new Promise<void>((resolve) => { started = resolve; });
const release = new Promise<void>((resolve) => { finish = resolve; });
const cancelledStore = new ThreadBriefStore(cancellationRoot, now);
const cancellation = new ThreadBriefService({ store: cancelledStore, readThread: async () => makeThread("cancel"), getModel: async () => ({
  provider: "test", modelId: "slow", stream: async function* () {
    started();
    await release;
    yield { type: "text-delta", text: JSON.stringify({ topic: "迟到结果", goal: "", objects: [], conclusions: [], followUp: null }) };
  }
}) });
try {
  await cancellation.initialize();
  const pending = cancellation.enqueue("cancel");
  const rejected = assert.rejects(pending, /设置已更改/u);
  await Promise.race([waiting, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Provider 未启动")), 2000); timer.unref(); })]);
  cancellation.setConfig({ ...cancelledStore.config(), enabled: false });
  await rejected;
  finish();
  assert.equal(cancelledStore.brief("cancel"), undefined);
} finally { finish(); await cancellation.close(); await rm(cancellationRoot, { recursive: true, force: true }); }

// 即使三个摘要提到同一对象，也要达到跨天门槛；模型筛选成员后再检查一次门槛。
const clusterRoot = await mkdtemp(path.join(os.tmpdir(), "biny-brief-cluster-"));
const clusterStore = new ThreadBriefStore(clusterRoot, now);
const clusterThreads = new Map(["a", "b", "c"].map((id) => [id, makeThread(id)]));
let members = [1, 2];
const clusterService = new ThreadBriefService({ store: clusterStore, readThread: async (id) => clusterThreads.get(id), getModel: async () => ({
  provider: "test", modelId: "cluster", stream: async function* (context) {
    const clustering = JSON.stringify(context.messages).includes("sameThing");
    yield { type: "text-delta", text: JSON.stringify(clustering
      ? { sameThing: true, members, name: "Canvas", brief: "上线编辑器", focus: "准备发布", reason: "共同推进上线" }
      : { topic: "Canvas", goal: "上线编辑器", objects: ["Canvas"], conclusions: [], followUp: null }) };
    yield { type: "finish", reason: "stop" };
  }
}) });
try {
  await clusterService.initialize();
  for (const id of clusterThreads.keys()) await clusterService.enqueue(id);
  assert.equal(clusterStore.snapshot().suggestions.length, 0, "同一天的重复讨论不足以建议建项目");
  clusterThreads.get("c")!.createdAt = "2026-09-24T00:00:00Z";
  clusterThreads.get("c")!.messages.push({ role: "user", text: "继续检查发布" });
  await clusterService.enqueue("c", true);
  assert.equal(clusterStore.snapshot().suggestions.length, 0, "语义筛选后只有两个成员，不能绕过三对话门槛");
  members = [1, 2, 3];
  clusterThreads.set("d", { ...makeThread("d", "2026-09-25T00:00:00Z"), title: "继续上线" });
  await clusterService.enqueue("d");
  assert.equal(clusterStore.snapshot().suggestions.length, 1);
} finally { await clusterService.close(); await rm(clusterRoot, { recursive: true, force: true }); }
console.log("thread brief tests passed");
