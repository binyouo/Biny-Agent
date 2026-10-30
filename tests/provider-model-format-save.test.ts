/** Actual renderer callbacks with a captured settings transaction; no mounted UI, IPC or persistence. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import { providerDefinition } from "../src/ai/provider.js";
import type { ModelApiBackend, ProviderConfig } from "../src/config/schema.js";
import { apiFormatForConnection, apiFormatOption, type ApiFormatId } from "../src/desktop/renderer/src/providerCatalog.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";

const sourcePath = path.resolve(process.cwd(), "src/desktop/renderer/src/components/settings/ProviderSettings.tsx");
const source = readFileSync(sourcePath, "utf8");
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function component(name: string): ts.FunctionDeclaration {
  const value = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(value?.body, `actual ${name} body`);
  return value;
}
function declaration(body: ts.FunctionDeclaration, name: string): ts.VariableDeclaration {
  const found = body.body!.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .filter(node => ts.isIdentifier(node.name) ? node.name.text === name
      : ts.isArrayBindingPattern(node.name) && node.name.elements.some(element => ts.isBindingElement(element) && element.name.getText(file) === name));
  assert.equal(found.length, 1, `unique actual ${name} declaration`);
  return found[0]!;
}
const settings = component("ProviderSettings");
const names = ["choiceUpsertInput", "saveModelOptions"];
const extracted = names.map(name => `const ${name} = ${declaration(settings, name).initializer!.getText(file)};`).join("\n");
const initialCall = declaration(component("ModelOptionsDialog"), "formatOverride").initializer;
assert.ok(initialCall && ts.isCallExpression(initialCall));
const initialExpression = initialCall.arguments[0]!.getText(file);
const javascript = ts.transpileModule(`${extracted}\nconst initialFormat = ${initialExpression};\n({ saveModelOptions, initialFormat });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

type Upsert = { apiBackend?: ModelApiBackend; protocol?: ProviderConfig["protocol"]; providerApiBackend?: ModelApiBackend;
  modelProfile?: { contextWindow?: number }; headers?: Record<string, string> };
const backends: ModelApiBackend[] = ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"];
for (const protocol of [undefined, "openai-compatible", "anthropic"] as const) {
  for (const originalBackend of backends) {
    for (const action of ["unchanged", "change", "reset"] as const) {
      test(`${protocol ?? "absent"} provider: ${originalBackend} model ${action} preserves connection routing`, async () => {
        let captured: Upsert | undefined;
        const model = { alias: "target", provider: "relay", model: "target-model", displayName: "Target", apiBackend: originalBackend,
          efforts: [], thinkingLevelMap: {} };
        const context = createContext({
          group: { provider: "relay" }, catalog: { value: "openai-compatible", requiresApiKey: true },
          connection: { protocol, baseUrl: "https://relay.invalid/v1" },
          target: { model }, apiFormat: apiFormatForConnection(protocol, originalBackend), apiFormatOption,
          useCallback: <T>(callback: T): T => callback,
          testOwnerRef: { current: undefined },
          settingsDraft: { draft: {}, saveModels: async (mutate: (snapshot: unknown) => { upserts: Upsert[] }) => {
            const result = mutate({ models: { modelProfiles: {} } });
            assert.equal(result.upserts.length, 1);
            captured = structuredClone(result.upserts[0]);
            return { status: "committed" };
          } }
        });
        const { saveModelOptions, initialFormat } = new Script(javascript, { filename: "actual-provider-format-callbacks.js" }).runInContext(context) as {
          initialFormat: ApiFormatId; saveModelOptions: (provider: string, model: unknown, options: unknown) => Promise<void>;
        };
        const changedBackend = backends[(backends.indexOf(originalBackend) + 1) % backends.length]!;
        const selected = action === "reset" ? undefined : action === "change" ? changedBackend : initialFormat;
        const expected = action === "reset" ? undefined : action === "change" ? changedBackend : originalBackend;
        await saveModelOptions("relay", model, { apiFormat: selected, profile: { contextWindow: 65_536 }, tools: true,
          reasoning: false, headers: { "x-test": "preserved" } });
        assert.ok(captured);
        assert.equal(captured.apiBackend, expected);
        assert.equal(captured.protocol, protocol, "single-model settings must retain the provider protocol");
        assert.equal(captured.providerApiBackend, undefined, "single-model settings must not set a connection backend");
        assert.equal(captured.modelProfile?.contextWindow, 65_536);
        assert.deepEqual(captured.headers, { "x-test": "preserved" });
        const provider: ProviderConfig = { type: "openai-compatible", protocol };
        const definition = providerDefinition(provider.type);
        const after = { ...provider, protocol: captured.protocol };
        // The main-process upsert stores input.protocol on the provider. A sibling without an override must retain its route.
        assert.deepEqual(resolveProviderRequestRoute(undefined, after, definition), resolveProviderRequestRoute(undefined, provider, definition));
        assert.deepEqual(resolveProviderRequestRoute({ apiBackend: captured.apiBackend }, after, definition),
          resolveProviderRequestRoute({ apiBackend: expected }, provider, definition));
      });
    }
  }
}
