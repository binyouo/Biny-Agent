import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
/** 标题持久化、手动重命名竞态、无效输出和取消；模型只用脚本，不访问外网。 */
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSessionTitle } from "../src/session/title.js";
import { readSessionCatalogRecord, updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-title-"));
let calls = 0;
let answer = "修复登录超时";
let duringRequest: (() => Promise<void>) | undefined;
const model: AgentModel = testModel({
  provider: "test", modelId: "title-helper",
  stream: async (context) => {
    calls += 1;
    assert.equal(context.tools.length, 0);
    assert.match(context.systemPrompt ?? "", /相同的语言/u);
    await duringRequest?.();
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: answer };
      yield { type: "finish", reason: "stop" };
    })();
  }
});
async function session(): Promise<string> {
  const recorder = new SessionRecorder(root);
  recorder.record({ type: "user_message", content: "帮我修复登录时出现的超时问题" });
  await recorder.close();
  return recorder.sessionId;
}
try {
  await ensureAgentDirs(root);
  const first = await session();
  assert.equal(await generateSessionTitle(root, first, model), answer);
  assert.equal((await readSessionCatalogRecord(root, first))?.title, answer);
  const before = calls;
  assert.equal(await generateSessionTitle(root, first, model), undefined);
  assert.equal(calls, before, "已有标题不重复请求模型");
  const renamed = await session();
  duringRequest = async () => { await updateSessionCatalogMetadata(root, renamed, { title: "我的标题", pinned: true }); };
  assert.equal(await generateSessionTitle(root, renamed, model), undefined);
  assert.equal((await readSessionCatalogRecord(root, renamed))?.title, "我的标题");
  duringRequest = undefined;
  for (const invalid of ["", "标题\n额外解释", "x".repeat(101)]) {
    answer = invalid;
    const id = await session();
    assert.equal(await generateSessionTitle(root, id, model), undefined);
    assert.equal((await readSessionCatalogRecord(root, id))?.title, undefined);
  }
  const cancelled = await session();
  const controller = new AbortController();
  duringRequest = async () => controller.abort();
  await assert.rejects(generateSessionTitle(root, cancelled, model, controller.signal), { name: "AbortError" });
  assert.equal((await readSessionCatalogRecord(root, cancelled))?.title, undefined);
  console.log("session title tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
