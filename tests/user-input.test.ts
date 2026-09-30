import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { createCredentialStore } from "../src/config/credentials.js";
import { createFileConfigStore } from "../src/config/store.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { UserInputRequests, userInputQuestionsSchema } from "../src/runtime/userInput.js";
import { createAskUserQuestionTool } from "../src/tools/askUserQuestion.js";

test("普通模式自动筛选保留澄清入口，用户显式关闭工具仍然有效", async () => {
  const options = {
    config: defaultConfig, input: "帮我做一个工具", history: [], previousTools: [], skills: [],
    tools: [{ name: "AskUserQuestion", description: "Ask for missing requirements", source: "builtin" as const }]
  };
  const selected = await preselectCapabilities(options);
  assert.ok(selected.tools.includes("AskUserQuestion"), "普通模式也必须能按需询问用户");
  assert.equal((await preselectCapabilities({ ...options, selection: { tools: "none", skills: "none" } })).tools, "none");
});

test("回答按会话和回合隔离，校验选项、完整性与重复提交，支持自由输入和跳过", async () => {
  const requests = new UserInputRequests();
  const input = userInputQuestionsSchema.parse({ questions: [{ id: "target", question: "放在哪里？", options: [{ label: "桌面" }, { label: "项目" }] }] });
  const context = { sessionId: "s", runId: "r", toolCallId: "q" };
  assert.throws(() => requests.request(input, context), /unavailable/);
  requests.setRun(context);
  const completion = requests.request(input, context);
  const answer = { status: "answered", answers: [{ id: "target", selected: ["桌面"] }] };
  for (const [sessionId, runId] of [["other", "r"], ["s", "old"]]) assert.throws(() => requests.answer(sessionId!, runId!, "q", answer), /no longer pending/);
  for (const answers of [[], [{ id: "target", selected: ["不存在"] }], [{ id: "target", selected: [] }], [{ id: "target", selected: ["桌面", "项目"] }]]) {
    assert.throws(() => requests.answer("s", "r", "q", { status: "answered", answers }));
    assert.equal(requests.list().length, 1, "无效答案保留等待，允许用户重试");
  }
  requests.answer("s", "r", "q", { status: "answered", answers: [{ id: "target", selected: [], text: "下载目录" }] });
  assert.deepEqual((await completion).response, { status: "answered", answers: [{ id: "target", selected: [], text: "下载目录" }] });
  assert.throws(() => requests.answer("s", "r", "q", answer), /no longer pending/);
  const skipped = requests.request(input, { ...context, toolCallId: "skip" });
  requests.answer("s", "r", "skip", { status: "skipped" });
  assert.deepEqual((await skipped).response, { status: "skipped" });
  const abort = new AbortController();
  const cancelled = requests.request(input, { ...context, signal: abort.signal });
  const rejected = assert.rejects(cancelled, /cancelled/);
  abort.abort();
  await rejected;
  assert.deepEqual(requests.list(), []);
  const ended = requests.request(input, context);
  const endedRejection = assert.rejects(ended, /run ended/);
  requests.setRun();
  await endedRejection;
});

test("多选按题目 id 对应；题目和选项不能歧义", async () => {
  const requests = new UserInputRequests();
  assert.equal(createAskUserQuestionTool(requests).name, "AskUserQuestion", "提问工具仍作为独立交互能力注册");
  assert.equal(userInputQuestionsSchema.safeParse({ questions: [{ id: "x", question: "选择", options: [{ label: "重复" }, { label: "重复" }] }] }).success, false);
  assert.equal(userInputQuestionsSchema.safeParse({ questions: [{ id: "x", question: "一" }, { id: "x", question: "二" }] }).success, false);
  const input = userInputQuestionsSchema.parse({ questions: [
    { id: "features", question: "需要哪些功能？", multiSelect: true, options: [{ label: "导入" }, { label: "导出" }] },
    { id: "name", question: "名称是什么？" }
  ] });
  requests.setRun({ sessionId: "s", runId: "r" });
  const pending = requests.request(input, { sessionId: "s", runId: "r", toolCallId: "multi" });
  const response = { status: "answered", answers: [{ id: "name", selected: [], text: "编辑器" }, { id: "features", selected: ["导入", "导出"] }] };
  requests.answer("s", "r", "multi", response);
  assert.deepEqual((await pending).response, response);
});

test("真实运行时只在交互回合暴露提问工具，回合结束撤销入口", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-user-input-"));
  const saved = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  try {
    const configStore = createFileConfigStore(root, { globalDir: path.join(root, "state"), credentialStore: createCredentialStore("linux") });
    const config = structuredClone(defaultConfig);
    config.defaultModel = "test-model";
    config.providers = { test: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
    config.models = { "test-model": { ...defaultConfig.models[defaultConfig.defaultModel]!, provider: "test", model: "test-model" } };
    await configStore.save(config);
    const runtime = await createCommandRuntime(root, { configStore });
    try {
      assert.equal(runtime.listTools().some((tool) => tool.name === "AskUserQuestion"), false);
      assert.equal(typeof runtime.setUserInputRun, "function", "运行时缺少交互提问的回合入口");
      runtime.setUserInputRun!({ sessionId: "s", runId: "r" });
      assert.equal(runtime.listTools().some((tool) => tool.name === "AskUserQuestion"), true);
      runtime.setUserInputRun!();
      assert.equal(runtime.listTools().some((tool) => tool.name === "AskUserQuestion"), false);
    } finally {
      await runtime.close();
    }
  } finally {
    if (saved === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});
