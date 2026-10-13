import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { analyzeActivitySession } from "../src/activity/analyzer.js";
import { ActivityStore } from "../src/activity/store.js";

// Normal CI only: actual parser, normalization, injected model stream and temporary SQLite.
// Local audit wrappers never import or execute this file.
const payload = {
  worth: true,
  title: "支持 ```JSON 围栏",
  description: "支持 ```json 和 ```；保留引号 \"quoted\"、路径 C:\\docs 与花括号 {}。",
  summary: "example:\n```json\n{\"ok\":true}\n```\n保留原文。",
  topics: ["Markdown"],
  entities: { decisions: ["保留 ```json 标记"], identifiers: ["renderFence"] },
  memoryCandidates: [{ type: "feedback", content: "用户偏好 ```JSON 围栏", why: "明确且稳定的格式偏好" }]
};
const wrappers: Array<[string, (body: string) => string]> = [
  ["plain JSON", body => body],
  ["uppercase CRLF fence", body => "```JSON\r\n" + body + "\r\n```"]
];

for (const [name, wrap] of wrappers) {
  test("activity JSON strings survive storage and cache: " + name, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-analysis-json-fences-"));
    const store = new ActivityStore();
    let calls = 0;
    const model: AgentModel = {
      provider: "test", modelId: "json-fence-fixture", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async () => {
        calls += 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: wrap(JSON.stringify(payload)) };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const candidates: unknown[] = [];
    try {
      await store.open(root, root);
      const id = store.startSession("2026-08-26T09:00:00.000Z");
      store.recordEvent({ sessionId: id, occurredAt: "2026-08-26T09:00:01.000Z", eventType: "app_focus", application: "Markdown Editor" });
      store.endSession(id, "2026-08-26T10:00:00.000Z");
      const deps = { store, model, now: () => new Date("2026-08-26T11:00:00.000Z"),
        writeMemories: async (items: readonly unknown[]) => { candidates.push(...items); } };
      const first = await analyzeActivitySession(deps, id);
      assert.equal(first.status, "analyzed");
      assert.equal(first.status === "analyzed" ? first.cached : undefined, false);
      const stored = store.getAnalysis(id);
      assert.ok(stored);
      assert.equal(stored.title, payload.title);
      assert.equal(stored.description, payload.description);
      assert.equal(stored.summary, payload.summary);
      assert.deepEqual(stored.decisions, payload.entities.decisions);
      assert.deepEqual(stored.identifiers, payload.entities.identifiers);
      assert.deepEqual(candidates, payload.memoryCandidates);
      assert.equal(calls, 1);
      await store.close();
      await store.open(root, root);
      assert.deepEqual(store.getAnalysis(id), stored, "SQLite readback preserves strings exactly");
      const cached = await analyzeActivitySession(deps, id);
      assert.equal(cached.status, "analyzed");
      assert.equal(cached.status === "analyzed" ? cached.cached : undefined, true);
      assert.deepEqual(cached.status === "analyzed" ? cached.analysis : undefined, stored);
      assert.equal(calls, 1, "cache read does not repeat the model request");
      assert.deepEqual(candidates, payload.memoryCandidates, "cache read does not repeat projection");
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
