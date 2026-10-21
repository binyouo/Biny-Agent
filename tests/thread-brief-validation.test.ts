import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentModel } from "../src/agent/core/types.js";
import { ThreadBriefService } from "../src/session/threadBriefService.js";
import { ThreadBriefStore } from "../src/session/threadBriefStore.js";

const valid = { topic: "检查发布", goal: "发布编辑器", objects: ["Canvas"], conclusions: [], followUp: null };

async function fixture(run: (context: {
  service: ThreadBriefService; store: ThreadBriefStore; requests: string[];
  respond: (request: number) => unknown; material: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-brief-validation-"));
  const store = new ThreadBriefStore(directory);
  const context = {
    service: undefined as unknown as ThreadBriefService, store, requests: [] as string[],
    respond: (_request: number): unknown => valid, material: "检查编辑器"
  };
  const model: AgentModel = testModel({ provider: "test", modelId: "brief-validation", stream: async function* (input) {
    context.requests.push(JSON.stringify(input.messages));
    const response = context.respond(context.requests.length);
    yield { type: "text-delta", text: JSON.stringify(response) };
    yield { type: "finish", reason: "stop" };
  } });
  context.service = new ThreadBriefService({ store, getModel: async () => model, readThread: async (sessionId) => ({
    sessionId, projectId: "workspace", title: "发布", createdAt: "2026-10-17T00:00:00Z",
    messages: [{ role: "user", text: context.material }]
  }) });
  try {
    await context.service.initialize();
    context.service.setConfig({ ...store.config(), projectSuggestions: false });
    await run(context);
  } finally {
    await context.service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [label, invalid, diagnostic] of [
  ["missing field", { ...valid, followUp: undefined }, "followUp: invalid_type"],
  ["too many objects", { ...valid, objects: Array(9).fill("Canvas") }, "objects: too_big"],
  ["long goal", { ...valid, goal: "私".repeat(401) }, "goal: too_big"]
] as const) {
  test(`repairs ${label} once before saving`, { timeout: 5000 }, async () => fixture(async (x) => {
    x.respond = (request) => request === 1 ? invalid : valid;
    await x.service.enqueue("repair", true);
    assert.equal(x.requests.length, 2);
    assert.ok(x.requests[1]!.includes(diagnostic), "correction receives the failed field and rule");
    assert.deepEqual(x.store.brief("repair")?.brief, valid);
    assert.equal(x.store.snapshot().lastError, undefined);
  }));
}

test("persistent invalid fields preserve the previous brief and report only field diagnostics", { timeout: 5000 }, async () => fixture(async (x) => {
  await x.service.enqueue("existing", true);
  const before = x.store.brief("existing");
  x.material = "补充新的发布要求";
  x.respond = () => ({ ...valid, followUp: { what: "PRIVATE MODEL OUTPUT", quote: 42 } });
  await assert.rejects(x.service.enqueue("existing", true), /followUp\.quote/u);
  assert.equal(x.requests.length, 3, "one initial request and at most two requests per refresh");
  assert.deepEqual(x.store.brief("existing"), before);
  assert.match(x.store.snapshot().lastError!.message, /followUp\.quote/u);
  assert.doesNotMatch(x.store.snapshot().lastError!.message, /PRIVATE MODEL OUTPUT/u);
  assert.doesNotMatch(x.requests[2]!, /PRIVATE MODEL OUTPUT/u);
}));

test("corrected follow-up still requires a quote from the user", { timeout: 5000 }, async () => fixture(async (x) => {
  x.respond = (request) => request === 1 ? { ...valid, goal: null } : {
    ...valid, followUp: { what: "明天发布", quote: "明天我会发布" }
  };
  await x.service.enqueue("quote", true);
  assert.equal(x.requests.length, 2);
  assert.equal(x.store.brief("quote")?.brief.followUp, null);
  assert.equal(x.store.brief("quote")?.status, "inbox");
}));

test("provider errors are not retried as invalid fields", { timeout: 5000 }, async () => fixture(async (x) => {
  x.respond = () => { throw new Error("provider disconnected"); };
  await assert.rejects(x.service.enqueue("failure", true), /provider disconnected/u);
  assert.equal(x.requests.length, 1);
  assert.equal(x.store.brief("failure"), undefined);
}));

test("cancelling before correction prevents another model call", { timeout: 5000 }, async () => fixture(async (x) => {
  x.respond = () => {
    x.service.setConfig({ ...x.store.config(), enabled: false });
    return { ...valid, goal: null };
  };
  await assert.rejects(x.service.enqueue("cancel", true), /设置已更改/u);
  assert.equal(x.requests.length, 1);
  assert.equal(x.store.brief("cancel"), undefined);
}));
