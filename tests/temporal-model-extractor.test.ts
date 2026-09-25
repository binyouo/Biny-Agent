/** 配置模型的日期提取须返回可由索引再次校验的结构化提议。 */
import assert from "node:assert/strict";
import { createTemporalModelExtractor } from "../src/session/temporalModelExtractor.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const prompts: string[] = [];
const model: AgentModel = {
  provider: "test", modelId: "temporal",
  async stream(context) {
    const input = context.messages.at(-1);
    prompts.push(input?.role === "user" && typeof input.content === "string" ? input.content : "");
    const output = prompts.length === 1
      ? '[{"expression":"明天","date":"2026-09-25","endDate":null,"time":null,"offset":0,"quote":"明天交报告"}]'
      : '[{"title":"提交报告","quote":"已提交报告","state":"completed","eventDate":"2026-09-25","dueDate":null,"completedDate":"2026-09-25"}]';
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
const extractor = createTemporalModelExtractor(model);
const source = { sessionId: "s", messageId: "m", text: "明天交报告，已提交报告", sentAt: "2026-09-24T03:00:00.000Z", timeZone: "Asia/Shanghai" };
assert.equal((await extractor.extractClues?.(source) as Array<{ date: string }>)[0]?.date, "2026-09-25");
assert.equal((await extractor.extractFacts?.(source, source.text, 0) as Array<{ state: string }>)[0]?.state, "completed");
assert.ok(prompts[0]?.includes("Asia/Shanghai"));
assert.ok(prompts[1]?.includes("completedDate"));
console.log("temporal model extractor tests passed");
