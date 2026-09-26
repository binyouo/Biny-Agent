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
const longSource = { ...source, text: `${"x".repeat(6_000)}明天复盘` };
await extractor.extractClues?.(longSource);
const longEnvelope = JSON.parse(prompts[2]!.slice(prompts[2]!.indexOf("\n{") + 1)) as { originalText: string };
assert.equal(longEnvelope.originalText.length, 6_000, "a long original message must bound the model input");
assert.equal(longEnvelope.originalText, longSource.text.slice(0, 6_000));

let active = 0;
let peak = 0;
const release: Array<() => void> = [];
let firstTwoStarted: (() => void) | undefined;
const started = new Promise<void>((resolve) => { firstTwoStarted = resolve; });
let thirdStarted: (() => void) | undefined;
const third = new Promise<void>((resolve) => { thirdStarted = resolve; });
const slowModel: AgentModel = {
  provider: "test", modelId: "temporal-concurrency",
  async stream() {
    active += 1;
    peak = Math.max(peak, active);
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      await new Promise<void>((resolve) => {
        release.push(resolve);
        if (release.length === 2) firstTwoStarted?.();
        if (release.length === 3) thirdStarted?.();
      });
      active -= 1;
      yield { type: "text-delta", text: "[]" };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
const bounded = createTemporalModelExtractor(slowModel);
const calls = [1, 2, 3].map(() => bounded.extractClues!(source));
await started;
assert.equal(active, 2, "the third date-model call waits for one of two global slots");
release[0]!();
await third;
release[1]!();
release[2]!();
await Promise.all(calls);
assert.equal(peak, 2);
release.length = 0;
const secondStarted = new Promise<void>((resolve) => { firstTwoStarted = resolve; });
const waitingAbort = new AbortController();
const first = bounded.extractClues!(source);
const second = bounded.extractClues!(source);
const waiting = bounded.extractClues!(source, waitingAbort.signal);
await secondStarted;
waitingAbort.abort(new DOMException("Cancelled", "AbortError"));
await assert.rejects(waiting, { name: "AbortError" });
release[0]!();
release[1]!();
await Promise.all([first, second]);
assert.equal(release.length, 2, "an aborted waiter must not consume a released model slot");
console.log("temporal model extractor tests passed");
