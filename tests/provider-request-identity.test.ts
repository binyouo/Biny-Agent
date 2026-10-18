import assert from "node:assert/strict";
import test from "node:test";
import { vercelAgentLoopContinue } from "../src/agent/core/vercelAgentLoop.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { createVercelLanguageModel } from "../src/llm/vercelModel.js";

function fixture(headers: Record<string, string> = {}) {
  const requests: Headers[] = [];
  const vercelModel = createVercelLanguageModel({
    providerAlias: "fixture", providerType: "openai-compatible", authMode: "api-key", api: "chat_completions",
    modelId: "fixture", supportsReasoning: false, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", headers,
    fetcher: async (_input, init) => {
      requests.push(new Headers(init?.headers));
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  const model = { provider: "fixture", modelId: "fixture", vercelModel };
  const main = async (sessionId: string, content: string) => {
    for await (const event of vercelAgentLoopContinue({ messages: [{ role: "user", content }], tools: [] }, {
      model, vercelModel, tools: [], maxSteps: 1,
      modelOptions: { requestContext: { sessionId, operation: "agent" } }
    })) assert.notEqual(event.type, "error", JSON.stringify(event));
  };
  return { requests, model, main };
}

test("shared provider requests keep stable session IDs and distinguish primary and auxiliary work on the wire", async () => {
  const f = fixture();
  await Promise.all([
    f.main("session-a", "first user message"),
    f.main("session-a", "changed context and user message"),
    f.main("session-b", "a different conversation"),
    generateNativeText(f.model, [{ role: "user", content: "extract memory" }], {
      requestContext: { sessionId: "session-a", operation: "memory" }
    })
  ]);
  assert.equal(f.requests.length, 4);
  const primary = f.requests.filter(headers => headers.get("x-biny-operation") === "agent");
  assert.equal(primary.length, 3);
  assert.deepEqual(primary.map(headers => headers.get("x-session-id")).sort(), ["session-a", "session-a", "session-b"]);
  for (const headers of primary) assert.match(headers.get("user-agent") ?? "", /^biny(?:\s|$)/u);
  const auxiliary = f.requests.find(headers => headers.get("x-biny-operation") === "memory");
  assert.equal(auxiliary?.get("x-session-id"), "session-a");
  assert.match(auxiliary?.get("user-agent") ?? "", /^biny-auxiliary(?:\s|$)/u);
  for (const headers of f.requests) assert.equal(headers.get("authorization"), "Bearer fixture-key");
});

test("explicit provider User-Agent wins and auxiliary requests without session context invent no session", async () => {
  const f = fixture({ "User-Agent": "configured-client/1.0", "x-fixture": "configured" });
  await f.main("session-a", "hello");
  await generateNativeText(f.model, [{ role: "user", content: "background work" }]);
  assert.match(f.requests[0]?.get("user-agent") ?? "", /^configured-client\/1\.0(?:\s|$)/u);
  assert.match(f.requests[1]?.get("user-agent") ?? "", /^configured-client\/1\.0(?:\s|$)/u);
  assert.equal(f.requests[1]?.get("x-biny-operation"), "auxiliary");
  assert.equal(f.requests[1]?.get("x-session-id"), null);
  assert.equal(f.requests[1]?.get("x-fixture"), "configured");
});

test("invalid imported session identifiers cannot inject or invalidate HTTP headers", async () => {
  const f = fixture();
  await f.main("untrusted\r\nx-injected: value", "hello");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.get("x-session-id"), null);
  assert.equal(f.requests[0]?.get("x-injected"), null);
});
