import assert from "node:assert/strict";
import test from "node:test";
import { providerDefinition } from "../src/ai/provider.js";
import type { ModelApiBackend, ProviderConfig } from "../src/config/schema.js";
import { apiFormatForConnection, apiFormatOption } from "../src/desktop/renderer/src/providerCatalog.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";

const backends: ModelApiBackend[] = ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"];
for (const protocol of [undefined, "openai-compatible", "anthropic"] as const) {
  for (const apiBackend of backends) {
    test(`explicit ${apiBackend} survives settings projection over ${protocol ?? "absent"} protocol`, () => {
      const displayed = apiFormatForConnection(protocol, apiBackend);
      assert.equal(displayed, apiBackend);
      const saved = apiFormatOption(displayed);
      assert.equal(saved.apiBackend, apiBackend);
      const provider: ProviderConfig = { type: "openai-compatible", protocol };
      const definition = providerDefinition(provider.type);
      assert.deepEqual(
        resolveProviderRequestRoute({ apiBackend: saved.apiBackend }, provider, definition),
        resolveProviderRequestRoute({ apiBackend }, provider, definition)
      );
      assert.deepEqual(
        resolveProviderRequestRoute(undefined, { ...provider, apiBackend: saved.apiBackend }, definition),
        resolveProviderRequestRoute(undefined, { ...provider, apiBackend }, definition)
      );
    });
  }
  test(`legacy ${protocol ?? "absent"} protocol retains its format fallback`, () => {
    assert.equal(apiFormatForConnection(protocol), protocol === "anthropic" ? "anthropic_messages" : "chat_completions");
  });
}
