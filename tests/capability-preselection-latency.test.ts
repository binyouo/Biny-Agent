import assert from "node:assert/strict";
import test from "node:test";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";

const base = {
  input: "请使用 $review 和 WebSearch", config: defaultConfig, history: [], previousTools: [],
  tools: ["Read", "ToolSearch", "WebSearch", "WebFetch", "Skill", "read_skill_resource", "skill_lookup"].map((name) => ({ name, description: name, source: "builtin" as const })),
  skills: [{ id: "review", name: "review", description: "Review changes" }]
};

const backup: AgentModel = {
  provider: "test", modelId: "backup",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: '{"tools":["WebSearch"],"skillIds":["review"]}' };
  })()
};

test("automatic selection allows responses beyond two seconds but cancels both requests at ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = 0;
  let aborted = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => { allStarted = resolve; });
  const slow: AgentModel = {
    provider: "test", modelId: "slow",
    stream: async (_context, options) => {
      if (++started === 2) allStarted();
      await new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => { aborted++; reject(options!.signal!.reason); }, { once: true });
      });
      throw new Error("unreachable");
    }
  };
  let settled = false;
  const result = preselectCapabilities({ ...base, models: [{ model: slow, failureDomain: "slow" }] }).then((value) => { settled = true; return value; });
  await ready;
  t.mock.timers.tick(2000);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(settled, false, "A normally slow selector must not lose its result at the former two-second cutoff");
  assert.equal(aborted, 0);
  t.mock.timers.tick(8000);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(settled, true, "Selection remains bounded when the model never responds");
  assert.equal(aborted, 2);
  const selected = await result;
  assert.ok(Array.isArray(selected.tools) && selected.tools.includes("WebSearch") && selected.tools.includes("ToolSearch"));
  assert.deepEqual(selected.skills, ["review"], "Explicit capabilities survive selection timeout");
});

test("a selector response after three seconds still activates capabilities not explicitly named", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = 0;
  let ready!: () => void;
  const bothStarted = new Promise<void>(resolve => { ready = resolve; });
  const slow: AgentModel = { provider: "test", modelId: "slow-success", stream: async () => {
    const wait = new Promise<void>(resolve => setTimeout(resolve, 3_000));
    if (++started === 2) ready();
    await wait;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: '{"tools":["WebFetch"],"skillIds":["review"]}' };
    })();
  } };
  const pending = preselectCapabilities({ ...base, input: "分析资料", models: [{ model: slow, failureDomain: "slow" }] });
  await bothStarted;
  t.mock.timers.tick(3_000);
  const selected = await pending;
  assert.ok(Array.isArray(selected.tools) && selected.tools.includes("WebFetch"));
  assert.deepEqual(selected.skills, ["review"]);
});

test("permanent connection failures cool down only within the owning runtime and expire", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const unavailableConnections = new Map<string, { retryAt: number; failures: number }>();
  let failures = 0;
  const failed: AgentModel = { provider: "test", modelId: "empty", stream: async () => {
    failures++;
    throw Object.assign(new Error("Insufficient Balance"), { statusCode: 402 });
  } };
  const models = [{ model: failed, failureDomain: "empty" }, { model: backup, failureDomain: "backup" }];
  const first = await preselectCapabilities({ ...base, models, selectionState: { unavailableConnections } });
  assert.deepEqual(first.skills, ["review"]);
  const before = failures;
  await preselectCapabilities({ ...base, models, selectionState: { unavailableConnections } });
  assert.equal(failures, before, "The next turn must skip the known failed account");
  await preselectCapabilities({ ...base, models, selectionState: { unavailableConnections: new Map() } });
  assert.ok(failures > before, "Separate runtimes do not share failure state");
  const beforeExpiry = failures;
  t.mock.timers.tick(Math.max(...[...unavailableConnections.values()].map((entry) => entry.retryAt)) - Date.now());
  await preselectCapabilities({ ...base, models, selectionState: { unavailableConnections } });
  assert.ok(failures > beforeExpiry, "An expired failure must be retried");
});

test("temporary failures and user cancellation do not disable a connection", async () => {
  const unavailableConnections = new Map<string, { retryAt: number; failures: number }>();
  const failed: AgentModel = { provider: "test", modelId: "network", stream: async () => { throw new Error("Network disconnected"); } };
  await preselectCapabilities({ ...base, models: [{ model: failed, failureDomain: "network" }], selectionState: { unavailableConnections } });
  assert.equal(unavailableConnections.size, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preselectCapabilities({ ...base, models: [{ model: backup, failureDomain: "backup" }], selectionState: { unavailableConnections }, signal: controller.signal }), { name: "AbortError" });
  assert.equal(unavailableConnections.size, 0);
});
