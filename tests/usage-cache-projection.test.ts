/** Additive cache measurement projection; legacy scalar compatibility is pinned to durable88. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentUsage } from "../src/agent/core/types.js";
import type { SessionUsage, UsageSummary } from "../src/session/metadata.js";
import { readReportedCacheRates } from "../src/session/metadata.js";
import { fromVercelUsage } from "../src/agent/core/vercelModelAdapter.js";
import { createSessionUsage, sumSessionUsage, summarizeUsage, formatUsageSummary } from "../src/observability/usage.js";
import { parseSessionEvents } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { writeSessionSnapshot, tryReadSessionSnapshot, snapshotToReplay } from "../src/session/sessionSnapshot.js";
import { encodeHostFrame, decodeHostFrame } from "../src/runtime/host/protocol.js";
import { buildUsageDetailRows } from "../src/desktop/renderer/src/chatModel.js";
import { lastReportedInputTokens } from "../src/desktop/renderer/src/app/desktopState.js";
import { buildUsageCard } from "../src/runtime/commandCards.js";
import { formatStatusReport } from "../src/runtime/statusReport.js";
import { BinyTui } from "../src/tui/app.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

interface Projection {
  version: 1;
  inputTokens?: number;
  cacheReadTokens?: number;
  inputTokensComplete?: boolean;
  cacheReadTokensComplete?: boolean;
  latestRequestRecorded?: true;
  latestRequestInputTokens?: number;
  latestRequestCacheReadTokens?: number;
  latestCacheHitRate?: number;
  sessionCacheHitRate?: number;
  epochCacheHitRates?: Record<string, number | null>;
}
const projection = (value: SessionUsage | UsageSummary): Projection | undefined =>
  (value as typeof value & { reportedCacheUsage?: Projection }).reportedCacheUsage;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const legacy = <T extends object>(value: T): T => {
  const result = json(value) as T & { reportedCacheUsage?: Projection };
  delete result.reportedCacheUsage;
  return result;
};
const info = { modelAlias: "fixture", provider: "fixture", model: "fixture", pricing: {
  inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0.5
} };
const make = (usage: AgentUsage, epochId = "e") => createSessionUsage(usage, "agent", info,
  "2026-10-05T00:00:00Z", { epochId, stablePrefixHash: "fixture" });
const adapter = (inputTokens: number | undefined, cacheReadTokens: number | undefined) =>
  fromVercelUsage({ inputTokens, inputTokenDetails: { cacheReadTokens, cacheWriteTokens: undefined },
    outputTokens: 0, outputTokenDetails: { reasoningTokens: undefined } });
const detail = (usage: SessionUsage) => Object.fromEntries(buildUsageDetailRows(usage, {}).map(row => [row.key, row.value]));
const document = (usage: SessionUsage[]) => ({ events: usage.map(record => ({ type: "assistant_message" as const, content: "fixture", usage: record })) }) as Parameters<typeof lastReportedInputTokens>[0];
const rates = (records: SessionUsage[]) => projection(summarizeUsage(records));

interface GoldenCase {
  name: string; inputs: AgentUsage[]; records: SessionUsage[]; turn: SessionUsage; nested: SessionUsage;
  summary: UsageSummary; turnSummary: UsageSummary; nestedSummary: UsageSummary; report: string;
}
const golden = JSON.parse(await readFile(new URL("./fixtures/usage-cache-legacy-golden.json", import.meta.url), "utf8")) as { base: string; cases: GoldenCase[] };

test("new projection preserves normalized measured input/read counts independently", () => {
  const records = [make(adapter(undefined, 7)), make(adapter(10, 3))];
  const turn = sumSessionUsage(records);
  assert.deepEqual(json(projection(records[0]!)), { version: 1, inputTokensComplete: false,
    cacheReadTokens: 7, cacheReadTokensComplete: true, latestRequestRecorded: true,
    latestRequestCacheReadTokens: 7 });
  assert.equal(turn.inputTokens, 10);
  assert.equal(turn.cacheReadTokens, undefined, "old readers retain the suppressed numerator");
  const p = projection(turn)!;
  assert.equal(p.inputTokens, 10); assert.equal(p.cacheReadTokens, 10);
  assert.equal(p.inputTokensComplete, false); assert.equal(p.cacheReadTokensComplete, true);
  const summary = rates([turn])!;
  assert.equal(summary.latestCacheHitRate, 0.3);
  assert.equal(summary.sessionCacheHitRate, undefined);
  assert.deepEqual(summary.epochCacheHitRates, { e: null });
});

test("every existing scalar/count/rate/cost output stays equal to durable88 golden values", () => {
  assert.equal(golden.base, "a5826c37bdcb85738503c936f0413bfef1c14e6c");
  for (const fixture of golden.cases) {
    const records = fixture.inputs.map(usage => make(usage));
    const turn = sumSessionUsage(records);
    const nested = records.length > 1 ? sumSessionUsage([records[0]!, sumSessionUsage(records.slice(1))]) : turn;
    assert.deepEqual(records.map(legacy), fixture.records, fixture.name);
    assert.deepEqual(legacy(turn), fixture.turn, fixture.name);
    assert.deepEqual(legacy(nested), fixture.nested, fixture.name);
    assert.deepEqual(legacy(summarizeUsage(records)), fixture.summary, fixture.name);
    assert.deepEqual(legacy(summarizeUsage([turn])), fixture.turnSummary, fixture.name);
    assert.deepEqual(legacy(summarizeUsage([nested])), fixture.nestedSummary, fixture.name);
    assert.equal(projection(sumSessionUsage(fixture.records)), undefined);
    assert.equal(projection(summarizeUsage(fixture.records)), undefined);
    assert.equal(formatUsageSummary(summarizeUsage(fixture.records)), fixture.report);
    if (records.length > 1) {
      const mixed = [records[0]!, ...fixture.records.slice(1)];
      assert.deepEqual(legacy(sumSessionUsage(mixed)), fixture.turn, `${fixture.name} mixed scalars`);
      assert.deepEqual(legacy(summarizeUsage(mixed)), fixture.summary, `${fixture.name} mixed summary`);
    }
  }
});

test("strict latest input/read absence survives reversed and nested aggregates", () => {
  for (const final of [adapter(undefined, 7), adapter(20, undefined), adapter(undefined, undefined)]) {
    const records = [make(adapter(10, 3)), make(adapter(30, 4)), make(final)];
    const flat = sumSessionUsage(records);
    const nested = sumSessionUsage([records[0]!, sumSessionUsage(records.slice(1))]);
    assert.deepEqual(json(projection(nested)), json(projection(flat)));
    assert.equal(projection(nested)?.latestRequestRecorded, true);
    assert.equal(projection(nested)?.latestRequestInputTokens, final.inputTokens);
    assert.equal(projection(nested)?.latestRequestCacheReadTokens, final.cacheReadTokens);
    assert.equal(rates([nested])?.latestCacheHitRate, undefined);
    const rows = detail(nested);
    if (final.inputTokens === undefined) assert.equal(rows.input, undefined);
    if (final.cacheReadTokens === undefined) assert.equal(rows.cacheRead, undefined);
    assert.equal(rows.cacheHit, undefined);
  }
  const reversed = sumSessionUsage([make(adapter(10, 3)), make(adapter(undefined, 7))]);
  assert.equal(detail(reversed).cacheRead, "7");
  assert.equal(lastReportedInputTokens(document([make(adapter(40, 20)), reversed])), undefined);
  assert.equal(lastReportedInputTokens(document([reversed, make(adapter(50, 25))])), 50);
  assert.equal(lastReportedInputTokens(document([legacy(make(adapter(40, 20))), legacy(make(adapter(undefined, 7)))])), 40);
});

test("weighted/epoch rates, zeros, unknown counts and legacy-unknown completeness stay distinct", () => {
  const complete = [make({ inputTokens: 100, cacheReadTokens: 0 }), make({ inputTokens: 900, cacheReadTokens: 900 })];
  assert.equal(rates(complete)?.sessionCacheHitRate, 0.9);
  assert.equal(rates([sumSessionUsage(complete)])?.sessionCacheHitRate, 0.9);
  assert.equal(rates([make({ inputTokens: 0, cacheReadTokens: 0 })])?.sessionCacheHitRate, undefined);
  const partialZero = rates([make({ inputTokens: 10, cacheReadTokens: 0 }), make({ inputTokens: 20 })])!;
  assert.equal(partialZero.cacheReadTokens, 0); assert.equal(partialZero.cacheReadTokensComplete, false);
  const none = rates([make({})])!;
  assert.equal(none.inputTokens, undefined); assert.equal(none.cacheReadTokens, undefined);
  const mixed = [complete[0]!, legacy(complete[1]!)];
  const m = rates(mixed)!;
  assert.equal(m.inputTokens, 1000); assert.equal(m.cacheReadTokens, 900);
  assert.equal(m.inputTokensComplete, undefined); assert.equal(m.cacheReadTokensComplete, undefined);
  assert.equal(m.sessionCacheHitRate, undefined); assert.equal(m.latestCacheHitRate, undefined);
  assert.deepEqual(json(rates([sumSessionUsage(mixed)])), json(m));
  const epochs = rates([make(adapter(undefined, 7), "bad"), make(adapter(10, 3), "bad"), make(adapter(20, 4), "good")])!;
  assert.deepEqual(epochs.epochCacheHitRates, { bad: null, good: 0.2 });
  assert.equal(projection(sumSessionUsage([sumSessionUsage(mixed), complete[0]!]))?.inputTokensComplete, undefined);
});

test("projection including an explicitly absent latest snapshot crosses JSONL/replay/snapshot/host frames", async () => {
  const record = sumSessionUsage([make(adapter(10, 3)), make(adapter(undefined, undefined))]);
  const event = { type: "assistant_message", content: "fixture", usage: record };
  const events = parseSessionEvents(JSON.stringify(event) + "\n");
  const replay = replaySessionEvents(events);
  assert.deepEqual(json(projection(replay.usage[0]!)), json(projection(record)));
  assert.equal(projection(replay.usage[0]!)?.latestRequestRecorded, true);
  assert.equal(rates(replay.usage)?.latestCacheHitRate, undefined);
  const root = await mkdtemp(path.join(tmpdir(), "biny-cache-projection-"));
  try {
    const jsonl = path.join(root, "fixture.jsonl");
    const fingerprint = { size: 123, mtimeMs: 456 };
    await writeSessionSnapshot(jsonl, fingerprint, replay);
    const snap = await tryReadSessionSnapshot(jsonl, fingerprint);
    assert.ok(snap);
    assert.deepEqual(json(projection(snapshotToReplay(snap).usage[0]!)), json(projection(record)));
  } finally { await rm(root, { recursive: true, force: true }); }
  const frame = decodeHostFrame(encodeHostFrame({ kind: "response", requestId: "fixture", ok: true,
    result: { usage: record, summary: summarizeUsage(replay.usage) } })) as { result: { usage: SessionUsage; summary: UsageSummary } };
  assert.deepEqual(json(projection(frame.result.usage)), json(projection(record)));
  assert.deepEqual(json(projection(frame.result.summary)), json(rates(replay.usage)));
});

test("active text/card consumers prefer projection presence including unknown rates", () => {
  const summary = summarizeUsage([make(adapter(undefined, 7)), make(adapter(10, 3))]);
  assert.match(formatUsageSummary(summary), /Input tokens: 10 \(partial\)/u);
  assert.match(formatUsageSummary(summary), /Cache read\/write\/miss: 10\//u);
  assert.match(formatUsageSummary(summary), /Epoch cache hit rates: e=unknown/u);
  const card = JSON.stringify(buildUsageCard(summary));
  assert.match(card, /partial/u); assert.match(card, /"tokens":10/u);
  assert.doesNotMatch(card, /100%/u);
  const context = { loadedInstructions: [], instructionBytes: 0, instructionCapBytes: 0,
    repoMapEntries: 0, repoMapDirty: false, memoryEnabled: false, activePaths: [],
    compaction: { summaryPresent: false, compactedMessages: 0 },
    budget: { maxTokens: 100, usedTokens: 10, omitted: [], autoCompacted: false } } as Parameters<typeof formatStatusReport>[2];
  const agentInfo = { modelLabel: "fixture", reasoningLabel: "", provider: "fixture", workspaceRoot: "/fixture", sessionId: "fixture" } as Parameters<typeof formatStatusReport>[0];
  assert.match(formatStatusReport(agentInfo, "ask", context, summary, ""), /10 \(partial\) input/u);
  const unknown = summarizeUsage([make({})]);
  assert.match(formatUsageSummary(unknown), /Input tokens: unknown/u);
  const mixed = summarizeUsage([make(adapter(10, 3)), legacy(make(adapter(20, 4)))]);
  assert.match(formatUsageSummary(mixed), /completeness unknown/u);
});

test("TUI footer does not fall back to a legacy rate when projected rate is unknown", async () => {
  const summary = summarizeUsage([make(adapter(undefined, 7)), make(adapter(10, 3))]);
  summary.latestCacheHitRate = 1; summary.sessionCacheHitRate = 1;
  const tui = Object.create(BinyTui.prototype) as {
    runtime: { getSnapshot(): { info: { sessionId: string } } };
    commands: { agent: { usageSummary(): UsageSummary } };
    cacheHitRate?: number; sessionCacheHitRate?: number; refreshChrome(): void; refreshUsage(): Promise<void>;
  };
  Object.assign(tui, { runtime: { getSnapshot: () => ({ info: { sessionId: "fixture" } }) },
    commands: { agent: { usageSummary: () => summary } }, refreshChrome: () => undefined });
  await tui.refreshUsage();
  assert.equal(tui.cacheHitRate, 0.3); assert.equal(tui.sessionCacheHitRate, undefined);
});

test("unsupported projection is ignored; recognized malformed counts cannot manufacture a ratio", () => {
  const record = legacy(make(adapter(10, 3)));
  const unsupported = { ...record, reportedCacheUsage: { version: 2, inputTokens: 1, cacheReadTokens: 1 } } as unknown as SessionUsage;
  assert.equal(projection(summarizeUsage([unsupported])), undefined);
  const malformed = { ...record, reportedCacheUsage: { version: 1, inputTokens: null, cacheReadTokens: "7",
    inputTokensComplete: true, cacheReadTokensComplete: true, latestRequestRecorded: true,
    latestRequestInputTokens: null, latestRequestCacheReadTokens: "7" } } as unknown as SessionUsage;
  assert.equal(rates([malformed])?.sessionCacheHitRate, undefined);
  assert.equal(rates([malformed])?.latestCacheHitRate, undefined);
  assert.equal(detail(malformed).cacheHit, undefined);
});

test("SDK-derived zero is supplied normalized presence, never recovered provider-wire or billing proof", async () => {
  for (const wire of [{}, undefined]) {
    const model = createVercelLanguageModel({
      providerAlias: "fixture", providerType: "openai-compatible", authMode: "api-key", api: "chat_completions",
      modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", headers: {},
      fetcher: async () => new Response([
        { choices: [{ index: 0, delta: { content: "fixture" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: wire }
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    });
    const response = await generateNativeText({ provider: "fixture", modelId: "fixture", vercelModel: model },
      [{ role: "user", content: "fixture" }], { maxRetries: 0 });
    const record = make(response.usage ?? {});
    // The SDK defaults absent fields in a present wire usage object to zero upstream of AgentUsage.
    assert.equal(record.inputTokens, wire ? 0 : undefined);
    assert.equal(record.cacheReadTokens, wire ? 0 : undefined);
    assert.equal(projection(record)?.inputTokensComplete, wire !== undefined);
    assert.equal(projection(record)?.cacheReadTokensComplete, wire !== undefined);
    assert.equal(rates([record])?.sessionCacheHitRate, undefined, "zero input is still not a usable denominator");
  }
});

test("malformed projected summary rates/maps stay unknown without legacy fallback", async () => {
  const base = summarizeUsage([make(adapter(10, 3))]);
  const malformed = { ...base, reportedCacheUsage: { version: 1, inputTokens: null, cacheReadTokens: "7",
    inputTokensComplete: true, cacheReadTokensComplete: true, latestCacheHitRate: null,
    sessionCacheHitRate: "0.9", epochCacheHitRates: { bad: "oops" } } } as unknown as UsageSummary;
  const text = formatUsageSummary(malformed);
  assert.match(text, /Latest cache hit rate: unknown/u);
  assert.match(text, /Session cache hit rate: unknown/u);
  assert.match(text, /bad=unknown/u);
  assert.doesNotMatch(text, /NaN|90%|30%/u);
  assert.doesNotMatch(JSON.stringify(buildUsageCard(malformed)), /NaN|90%|30%/u);
  for (const value of [null, "oops", [], { bad: NaN }, { bad: Infinity }, { bad: -1 }, { bad: 2 }]) {
    const summary = { ...base, reportedCacheUsage: { ...projection(base), latestCacheHitRate: Infinity,
      sessionCacheHitRate: -1, epochCacheHitRates: value } } as unknown as UsageSummary;
    assert.doesNotThrow(() => formatUsageSummary(summary));
    assert.doesNotMatch(formatUsageSummary(summary), /NaN|Infinity|30%/u);
  }
  const tui = Object.create(BinyTui.prototype) as {
    runtime: { getSnapshot(): { info: { sessionId: string } } };
    commands: { agent: { usageSummary(): UsageSummary } };
    cacheHitRate?: number; sessionCacheHitRate?: number; refreshChrome(): void; refreshUsage(): Promise<void>;
  };
  Object.assign(tui, { runtime: { getSnapshot: () => ({ info: { sessionId: "fixture" } }) },
    commands: { agent: { usageSummary: () => malformed } }, refreshChrome: () => undefined });
  await tui.refreshUsage();
  assert.equal(tui.cacheHitRate, undefined); assert.equal(tui.sessionCacheHitRate, undefined);
});

test("projected rate boundaries reject non-numbers and preserve only own prototype-looking epoch IDs", () => {
  const base = summarizeUsage([make(adapter(10, 3))]);
  for (const bad of [null, "0.3", {}, [], true, NaN, Infinity, -0.1, 1.1]) {
    const summary = { ...base, reportedCacheUsage: { ...projection(base), latestCacheHitRate: bad,
      sessionCacheHitRate: bad } } as unknown as UsageSummary;
    assert.equal(readReportedCacheRates(summary)?.latestCacheHitRate, undefined);
    assert.equal(readReportedCacheRates(summary)?.sessionCacheHitRate, undefined);
    assert.match(formatUsageSummary(summary), /Latest cache hit rate: unknown/u);
    assert.match(formatUsageSummary(summary), /Session cache hit rate: unknown/u);
  }
  const epochs = Object.create({ inherited: 0.5 }) as Record<string, number | null>;
  Object.defineProperties(epochs, {
    __proto__: { value: 0.25, enumerable: true },
    constructor: { value: null, enumerable: true },
    toString: { value: 0.75, enumerable: true }
  });
  // Object-literal __proto__ is special: define its own property explicitly.
  Object.defineProperty(epochs, "__proto__", { value: 0.25, enumerable: true });
  const summary = { ...base, reportedCacheUsage: { ...projection(base), epochCacheHitRates: epochs } } as UsageSummary;
  const selected = readReportedCacheRates(summary)?.epochCacheHitRates;
  assert.ok(selected);
  assert.deepEqual(Object.keys(selected).sort(), ["__proto__", "constructor", "toString"].sort());
  assert.equal(Object.hasOwn(selected, "__proto__"), true);
  assert.equal(selected["__proto__"], 0.25);
  assert.equal(Object.hasOwn(selected, "inherited"), false);
  assert.doesNotMatch(formatUsageSummary(summary), /inherited/u);
  const actual = rates([make(adapter(10, 3), "__proto__"), make(adapter(20, 4), "constructor"), make(adapter(30, 6), "toString")])!.epochCacheHitRates!;
  assert.equal(Object.hasOwn(actual, "__proto__"), true);
  assert.equal(actual["__proto__"], 0.3);
  assert.equal(actual.constructor, 0.2);
  assert.equal(actual.toString, 0.2);
});
