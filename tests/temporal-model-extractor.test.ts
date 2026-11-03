import { testModel } from "./helpers/model.js";
/** 配置模型的工作事实提取须返回可由索引再次校验的结构化提议。 */
import assert from "node:assert/strict";
import { createTemporalModelExtractor } from "../src/session/temporalModelExtractor.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const prompts: string[] = [];
const model: AgentModel = testModel({
  provider: "test", modelId: "temporal",
  async stream(context) {
    const input = context.messages.at(-1);
    prompts.push(input?.role === "user" && typeof input.content === "string" ? input.content : "");
    const output = '[{"title":"提交报告","quote":"已提交报告","state":"completed","eventDate":"2026-09-25","dueDate":null,"completedDate":"2026-09-25"}]';
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: "stop" };
    })();
  }
});
const extractor = createTemporalModelExtractor(model);
const source = { sessionId: "s", messageId: "m", text: "明天交报告，已提交报告", sentAt: "2026-09-24T03:00:00.000Z", timeZone: "Asia/Shanghai" };
assert.equal((await extractor.extractFacts?.(source, source.text, 0) as Array<{ state: string }>)[0]?.state, "completed");
assert.ok(prompts[0]?.includes("Asia/Shanghai"));
assert.ok(prompts[0]?.includes("completedDate"));
const envelope = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("\n{") + 1)) as { originalText: string; chunkOffset: number };
assert.equal(envelope.originalText, source.text);
assert.equal(envelope.chunkOffset, 0);
console.log("temporal model extractor tests passed");
