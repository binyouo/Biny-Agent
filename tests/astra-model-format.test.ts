/** Actual renderer expressions/callbacks; no mounted UI, IPC or configuration writes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ModelApiBackend, ProviderConfig } from "../src/config/schema.js";
import type { ModelChoice } from "../src/llm/ModelRegistry.js";
import { providerDefinition } from "../src/ai/provider.js";
import { resolveProviderRequestRoute } from "../src/llm/providerRequest.js";
import { apiFormatForConnection, apiFormatOption, recommendedApiFormat, type ApiFormatId } from "../src/desktop/renderer/src/providerCatalog.js";

const source = readFileSync(new URL("../src/desktop/renderer/src/components/settings/ProviderSettings.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("ProviderSettings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function component(name: string): ts.FunctionDeclaration {
  const found = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found?.body);
  return found;
}
function initializer(componentName: string, name: string): ts.Expression {
  const found = component(componentName).body!.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .filter(node => ts.isIdentifier(node.name) ? node.name.text === name
      : ts.isArrayBindingPattern(node.name) && node.name.elements.some(element => ts.isBindingElement(element) && element.name.getText(file) === name));
  assert.equal(found.length, 1, `unique actual ${name}`);
  assert.ok(found[0]?.initializer);
  return found[0].initializer;
}
let displayedFormat: ts.Expression | undefined;
let savedFormat: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === "ModelOptionsDialog") {
    const attribute = node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(file) === "apiFormat");
    assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
    displayedFormat = attribute.initializer.expression;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "onSave") {
    const argument = node.arguments[0];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      const property = argument.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name.getText(file) === "apiFormat");
      if (property) savedFormat = property.initializer;
    }
  }
  ts.forEachChild(node, visit);
}
visit(component("ProviderSettings"));
visit(component("ModelOptionsDialog"));
assert.ok(displayedFormat);
assert.ok(savedFormat);
const initialCall = initializer("ModelOptionsDialog", "formatOverride");
assert.ok(ts.isCallExpression(initialCall) && initialCall.arguments[0]);
const javascript = ts.transpileModule(`
  const apiFormat = ${displayedFormat.getText(file)};
  const initialFormat = ${initialCall.arguments[0].getText(file)};
  const formatOverride = selectedFormat ?? initialFormat;
  const savedFormat = ${savedFormat.getText(file)};
  const choiceUpsertInput = ${initializer("ProviderSettings", "choiceUpsertInput").getText(file)};
  const saveModelOptions = ${initializer("ProviderSettings", "saveModelOptions").getText(file)};
  ({ apiFormat, initialFormat, savedFormat, saveModelOptions });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Upsert = { apiBackend?: ModelApiBackend; providerApiBackend?: ModelApiBackend; protocol?: ProviderConfig["protocol"]; model: string };
interface Case {
  name: string;
  type?: string;
  baseUrl?: string;
  protocol?: ProviderConfig["protocol"];
  providerApi?: ModelApiBackend;
  modelApi?: ModelApiBackend;
  selected?: ApiFormatId | "provider_default";
  expected: ApiFormatId;
}
const cases: Case[] = [
  { name: "official automatic", expected: "responses" },
  { name: "compatible protocol is not explicit Chat", protocol: "openai-compatible", expected: "responses" },
  { name: "model Chat", modelApi: "chat_completions", expected: "chat_completions" },
  { name: "provider Chat", providerApi: "chat_completions", expected: "chat_completions" },
  { name: "model Chat beats provider Responses", modelApi: "chat_completions", providerApi: "responses", expected: "chat_completions" },
  { name: "legacy Anthropic", protocol: "anthropic", expected: "anthropic_messages" },
  { name: "third party OpenAI endpoint", baseUrl: "https://relay.example/v1", expected: "chat_completions" },
  { name: "generic compatible", type: "openai-compatible", expected: "chat_completions" },
  { name: "explicitly select Chat", selected: "chat_completions", expected: "responses" },
  { name: "reset a model Chat override", modelApi: "chat_completions", selected: "provider_default", expected: "chat_completions" }
];
for (const value of cases) {
  test(`${value.name}: displayed effective format does not become a saved automatic override`, async () => {
    const type = value.type ?? "openai";
    const baseUrl = value.baseUrl ?? "https://api.openai.com/v1";
    const model: ModelChoice = { alias: "astra", displayName: "Astra", provider: "official", providerType: type,
      model: "gpt-6-astra", modelKey: "official\0gpt-6-astra", efforts: ["high"], defaultThinking: "high", thinkingLevelMap: { high: "high" },
      apiBackend: value.modelApi, baseUrl, available: true, source: "configured" };
    let captured: Upsert | undefined;
    const profileTarget = { providerAlias: "official", model };
    const result = runInNewContext(javascript, {
      profileTarget, target: profileTarget, selectedFormat: value.selected,
      connection: { providerType: type, protocol: value.protocol, apiBackend: value.providerApi, baseUrl },
      group: { provider: "official" }, catalog: { value: type, baseUrl },
      apiFormatForConnection, apiFormatOption, recommendedApiFormat,
      useCallback: <T>(callback: T): T => callback, testOwnerRef: { current: undefined },
      settingsDraft: { draft: {}, saveModels: async (mutate: (snapshot: unknown) => { upserts: Upsert[] }) => {
        const mutation = mutate({ models: { modelProfiles: {} } });
        assert.equal(mutation.upserts.length, 1);
        captured = structuredClone(mutation.upserts[0]);
        return { status: "committed" };
      } }
    }) as { apiFormat: ApiFormatId; initialFormat: ApiFormatId | "provider_default"; savedFormat?: ModelApiBackend;
      saveModelOptions: (provider: string, model: ModelChoice, options: unknown) => Promise<void> };
    assert.equal(result.apiFormat, value.expected);
    assert.equal(result.initialFormat, value.modelApi ?? "provider_default");
    const selection = value.selected ?? value.modelApi;
    const saved = selection === "provider_default" ? undefined : selection;
    assert.equal(result.savedFormat, saved);
    await result.saveModelOptions("official", model, { apiFormat: result.savedFormat, profile: undefined, tools: true, reasoning: true, headers: {} });
    assert.ok(captured);
    assert.equal(captured.apiBackend, saved);
    assert.equal(captured.providerApiBackend, undefined);
    const after: ProviderConfig = { type, baseUrl, protocol: captured.protocol, apiBackend: value.providerApi };
    const routed = resolveProviderRequestRoute({ model: model.model, apiBackend: captured.apiBackend }, after, providerDefinition(type));
    const expectedAfter = value.selected === "provider_default" ? "responses" : value.selected ?? value.expected;
    assert.equal(routed.apiBackend, expectedAfter);
    assert.equal(model.apiBackend, value.modelApi);
  });
}

test("connection-level recommendation remains generic; only model display uses a model default", () => {
  assert.equal(recommendedApiFormat("openai"), "chat_completions");
  assert.equal(recommendedApiFormat("openai", undefined, { model: "gpt-6-astra" }), "responses");
});
