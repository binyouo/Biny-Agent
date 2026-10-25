import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { redactSecrets } from "../src/utils/redaction.js";

// Extract only audited declarations: never import the CLI, config store, Host,
// provider transport or credential backend. process.env below is a synthetic map.
const file = ts.createSourceFile("image.ts", readFileSync(new URL("../src/cli/commands/image.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["providerApiKey", "isGeminiProvider", "safeImageError", "splitProviderModel", "enabledGeminiAlias", "resolveImageModel", "pickBestGeminiModel", "imageModelsCommand"];
const declarations = names.map(name => {
  const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
});
const calls = new Set([
  "provider.apiKey?.trim", "process.env[envName]?.trim", "process.env[provider.apiKeyEnv]?.trim", "providerDefinition",
  "providerApiKey", "safe.split", 'safe.split(secret).join', "Object.values", "redactSecrets",
  "spec.indexOf", "spec.slice", "spec.slice(0, separator).trim", "(separator < 0 ? spec : spec.slice(separator + 1)).trim",
  '(separator < 0 ? spec : spec.slice(separator + 1)).trim().replace', '/[?#\\\\\\s]/u.test',
  "Object.keys", "Object.keys(config.providers).find", "isGeminiProvider", "Boolean", "config.imageGen.model?.trim",
  "splitProviderModel", "enabledGeminiAlias", "providerProtocol", "pickBestGeminiModel", "listGeminiImageModels",
  "modelIds.find", "id.includes", "imageConfigStore", "imageConfigStore(workspaceRoot, options).load",
  "Object.entries", "entries.push", "safeImageError", "String", "errors.push",
  '(provider.baseUrl ?? providerDefinition(provider.type).baseUrl!).replace', "imageRequest", "imageJson", "Array.isArray",
  '(config.imageGen?.model ?? "").replace', "entries.filter", 'entries.filter(entry => entry.value.startsWith(`${autoAlias}:`)).map',
  "entry.value.startsWith", "entry.value.slice", "entry.value.indexOf", "entries.some", "console.log", "JSON.stringify", "console.error"
]);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isNewExpression(node)) assert.ok(["URL", "Error"].includes(node.expression.getText(file)));
  if (ts.isCallExpression(node)) {
    const expression = node.expression.getText(file);
    assert.ok(calls.has(expression) || ts.isArrowFunction(node.expression) || (ts.isParenthesizedExpression(node.expression) && ts.isArrowFunction(node.expression.expression)), `Unexpected extracted call: ${expression}`);
  }
  ts.forEachChild(node, audit);
}
declarations.forEach(audit);
const priority = file.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(file) === "IMAGE_MODEL_PRIORITY"));
assert.ok(priority && ts.isVariableStatement(priority));
assert.ok(priority.declarationList.declarations.every(declaration => declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer) && declaration.initializer.elements.every(ts.isStringLiteral)));
const printer = ts.createPrinter();
function print(node: ts.FunctionDeclaration, source: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateFunctionDeclaration(node, node.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword), node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body), source);
}
const compiled = ts.transpileModule([priority.getText(file), ...declarations.map(node => print(node, file)), "({ providerApiKey, resolveImageModel, safeImageError, imageModelsCommand });"].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
interface Provider { type: string; apiKey?: string; apiKeyEnv?: string; enabled?: boolean; baseUrl?: string; headers?: Record<string, string> }
interface Config { providers: Record<string, Provider>; imageGen: { model?: string } }
interface Api {
  providerApiKey(provider: Provider): string | undefined;
  resolveImageModel(config: Config, override?: string): Promise<{ providerAlias: string; modelId: string }>;
  safeImageError(message: string, provider: Provider): string;
  imageModelsCommand(root: string, options: { json: boolean }): Promise<void>;
}
function fixture(config: Config) {
  const env = { GEMINI_API_KEY: "synthetic-gemini-value", OPENAI_API_KEY: "synthetic-openai-value", OPENROUTER_API_KEY: "synthetic-router-value", CUSTOM: "synthetic-custom-value", EMPTY: "  " };
  const output: string[] = [], catalogs: Provider[] = [];
  const forbidden = () => { throw new Error("Unexpected network or transport operation"); };
  const api = runInNewContext(compiled.outputText, {
    process: { env }, URL, redactSecrets,
    providerDefinition: (type: string) => ({ protocol: "openai-compatible", apiKeyEnv: ({ gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as Record<string, string>)[type] }),
    providerProtocol: (_provider: Provider, definition: { protocol: string }) => definition.protocol,
    imageConfigStore: () => ({ load: async () => config }),
    listGeminiImageModels: async (provider: Provider) => { catalogs.push(provider); return ["gemini-2.5-flash-image"]; },
    imageRequest: forbidden, imageJson: forbidden, fetch: forbidden,
    console: { log: (value: string) => output.push(value), error: forbidden }
  }, { timeout: 1_000 }) as Api;
  return { api, env, output, catalogs };
}
for (const type of ["gemini", "openai", "openrouter"]) test(`${type} configured image model uses its standard environment credential`, async () => {
  const provider = { type }, config = { providers: { selected: provider }, imageGen: { model: "selected:chosen-image" } };
  const { api, catalogs } = fixture(config);
  assert.ok(api.providerApiKey(provider)?.startsWith("synthetic-"));
  const result = await api.resolveImageModel(config);
  assert.equal(result.providerAlias, "selected"); assert.equal(result.modelId, "chosen-image");
  assert.equal(catalogs.length, 0);
  const key = api.providerApiKey(provider)!;
  assert.equal(api.safeImageError(`failure ${key}`, provider), "failure [redacted]");
});
test("explicit credential precedence never falls through a missing or blank custom variable", async () => {
  const config = { providers: { selected: { type: "gemini", apiKeyEnv: "CUSTOM" } }, imageGen: { model: "selected:chosen" } };
  const { api } = fixture(config);
  assert.equal(api.providerApiKey(config.providers.selected), "synthetic-custom-value");
  assert.equal(api.providerApiKey({ ...config.providers.selected, apiKey: " synthetic-inline " }), "synthetic-inline");
  for (const name of ["MISSING", "EMPTY"]) {
    const provider = { type: "gemini", apiKeyEnv: name };
    assert.ok(!api.providerApiKey(provider));
    await assert.rejects(api.resolveImageModel({ ...config, providers: { selected: provider } }), /has no API key/);
  }
});
test("disabled and absent configured providers do not fall back; manual override stays explicit", async () => {
  const config: Config = { providers: { selected: { type: "gemini", enabled: false }, alternate: { type: "openai" } }, imageGen: { model: "selected:chosen" } };
  const { api, catalogs } = fixture(config);
  await assert.rejects(api.resolveImageModel(config), /disabled/);
  delete config.providers.selected;
  await assert.rejects(api.resolveImageModel(config), /Unknown provider/);
  assert.equal((await api.resolveImageModel(config, "alternate:manual")).modelId, "manual");
  assert.equal(catalogs.length, 0);
});
test("standard Gemini credentials enable auto selection and model catalog inclusion", async () => {
  const config = { providers: { selected: { type: "gemini" } }, imageGen: {} };
  const { api, catalogs, output } = fixture(config);
  assert.equal((await api.resolveImageModel(config)).providerAlias, "selected");
  await api.imageModelsCommand("/inert", { json: true });
  const listed = JSON.parse(output[0]!) as { default: string; models: Array<{ value: string }> };
  assert.equal(listed.default, "selected:gemini-2.5-flash-image");
  assert.equal(listed.models[0]?.value, listed.default);
  assert.equal(catalogs.length, 2);
});
test("unregistered types and Gemini-like hostnames do not inherit another provider's env", async () => {
  for (const type of ["google", "custom", "openai-compatible"]) {
    const provider = { type, baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
    const config = { providers: { selected: provider }, imageGen: { model: "selected:chosen" } };
    const { api } = fixture(config);
    assert.equal(api.providerApiKey(provider), undefined);
    await assert.rejects(api.resolveImageModel(config), /has no API key/);
  }
});
