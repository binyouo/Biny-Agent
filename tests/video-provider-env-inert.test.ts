import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only these audited pure helpers execute. No CLI/module imports, config reads,
// uploads, provider transports, credential stores or real process.env access.
const source = ts.createSourceFile("video.ts", readFileSync(new URL("../src/cli/commands/video.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["providerApiKey", "isGeminiProvider", "normalizeGeminiBaseUrl", "splitModelReference", "resolveGeminiModel"];
const declarations = names.map(name => {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, name);
  return matches[0]!;
});
const calls = new Set([
  "provider.apiKey?.trim", "process.env[provider.apiKeyEnv]?.trim", "process.env[envName]?.trim", "providerDefinition",
  '(provider.baseUrl ?? definition?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta")\n    .replace',
  '(provider.baseUrl ?? definition?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta")\n    .replace(/\\/+$/u, "").replace',
  '/\\/v1(?:beta)?$/u.test', "reference.indexOf", "reference.slice", "reference.slice(0, colon).trim",
  '(colon < 0 ? reference : reference.slice(colon + 1)).trim',
  '(colon < 0 ? reference : reference.slice(colon + 1)).trim().replace', '/[?#\\\\\\s]/u.test',
  "splitModelReference", "isGeminiProvider", "Object.keys", "[...new Set([preferredAlias, ...Object.keys(config.providers)])].filter",
  "Boolean", "candidates.find", "providerApiKey", "normalizeGeminiBaseUrl"
]);
function audit(node: ts.Node): void {
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword);
  if (ts.isNewExpression(node)) assert.ok(["URL", "Error", "Set"].includes(node.expression.getText(source)));
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(source)), `Unexpected extracted call: ${node.expression.getText(source)}`);
  ts.forEachChild(node, audit);
}
declarations.forEach(audit);
const compiled = ts.transpileModule(declarations.map(node => node.getText(source)).join("\n") + "\n({ providerApiKey, resolveGeminiModel });", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
interface Provider { type: string; apiKey?: string; apiKeyEnv?: string; enabled?: boolean; baseUrl?: string }
interface Config { providers: Record<string, Provider>; models: Record<string, { provider: string; model: string }>; defaultModel: string }
interface Api {
  providerApiKey(provider: Provider): string | undefined;
  resolveGeminiModel(config: Config, override?: string): { alias: string; modelId: string; apiKey: string; baseUrl: string };
}
function fixture() {
  const forbidden = () => { throw new Error("Unexpected network/config/video operation"); };
  const env = Object.freeze({ GEMINI_API_KEY: " synthetic-gemini ", CUSTOM: " synthetic-custom ", BLANK: "  " });
  // Metadata stub only. The authoritative built-in literal is checked separately below.
  const api = runInNewContext(compiled.outputText, {
    process: { env }, URL,
    providerDefinition: (type: string) => type === "gemini"
      ? { apiKeyEnv: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" } : {},
    fetch: forbidden, createFileConfigStore: forbidden, openVideoInput: forbidden, getSharedProxyAwareFetch: forbidden
  }, { timeout: 1_000 }) as Api;
  const config: Config = { providers: { gem: { type: "gemini" } }, models: { chat: { provider: "gem", model: "gemini-2.5-flash" } }, defaultModel: "chat" };
  return { api, config };
}
test("metadata fixture matches the registered Gemini default without executing the registry", () => {
  const registry = ts.createSourceFile("provider.ts", readFileSync(new URL("../src/ai/provider.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const definitions = registry.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).filter(node => ts.isIdentifier(node.name) && node.name.text === "definitions");
  assert.equal(definitions.length, 1);
  const initializer = definitions[0]!.initializer;
  assert.ok(initializer && ts.isArrayLiteralExpression(initializer));
  const gemini = initializer.elements.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(registry) === "definition" && node.arguments[0]?.getText(registry) === '"gemini"');
  assert.equal(gemini.length, 1);
  assert.equal(gemini[0]!.arguments[1]?.getText(registry), '"https://generativelanguage.googleapis.com/v1beta/openai"');
  assert.equal(gemini[0]!.arguments[2]?.getText(registry), '"GEMINI_API_KEY"');
});
test("registered default enables configured video selection", () => {
  const { api, config } = fixture();
  assert.equal(api.providerApiKey(config.providers.gem!), "synthetic-gemini");
  const result = api.resolveGeminiModel(config);
  assert.equal(result.alias, "gem"); assert.equal(result.modelId, "gemini-2.5-flash");
  assert.equal(result.apiKey, "synthetic-gemini");
  assert.equal(result.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
});
test("registered default enables explicit provider and bare-model overrides", () => {
  const { api, config } = fixture();
  for (const override of ["gem:models/manual-video", "manual-video"]) {
    const result = api.resolveGeminiModel(config, override);
    assert.equal(result.alias, "gem"); assert.equal(result.modelId, "manual-video");
    assert.equal(result.apiKey, "synthetic-gemini");
  }
});
test("automatic Gemini selection respects default-provider preference", () => {
  const { api, config } = fixture();
  config.providers = { other: { type: "gemini", apiKey: "other-inline" }, gem: { type: "gemini" } };
  assert.equal(api.resolveGeminiModel(config).alias, "gem");
  config.defaultModel = "missing";
  delete config.providers.other;
  assert.equal(api.resolveGeminiModel(config).modelId, "gemini-2.5-flash");
});
test("inline and explicit env retain priority; missing or blank overrides never use defaults", () => {
  const { api, config } = fixture();
  assert.equal(api.providerApiKey({ type: "gemini", apiKeyEnv: "CUSTOM" }), "synthetic-custom");
  assert.equal(api.providerApiKey({ type: "gemini", apiKeyEnv: "CUSTOM", apiKey: " inline " }), "inline");
  for (const apiKeyEnv of ["MISSING", "BLANK"]) {
    config.providers.gem = { type: "gemini", apiKeyEnv };
    assert.ok(!api.providerApiKey(config.providers.gem));
    assert.throws(() => api.resolveGeminiModel(config, "gem:manual"), /Configure an enabled Gemini provider/);
  }
});
test("explicit missing or disabled provider never substitutes an available alternate", () => {
  const { api, config } = fixture();
  config.providers.alternate = { type: "gemini", apiKey: "alternate-inline" };
  config.providers.gem!.enabled = false;
  assert.throws(() => api.resolveGeminiModel(config, "gem:manual"), /Configure an enabled Gemini provider/);
  delete config.providers.gem;
  assert.throws(() => api.resolveGeminiModel(config, "gem:manual"), /Configure an enabled Gemini provider/);
  assert.equal(api.resolveGeminiModel(config, "alternate:manual").alias, "alternate");
});
test("unknown/google/hostname matches never borrow Gemini environment credentials", () => {
  const { api, config } = fixture();
  for (const type of ["google", "custom", "openai-compatible"]) {
    config.providers.gem = { type, baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
    assert.equal(api.providerApiKey(config.providers.gem), undefined);
    assert.throws(() => api.resolveGeminiModel(config), /Configure an enabled Gemini provider/);
    config.providers.gem.apiKeyEnv = "CUSTOM";
    assert.equal(api.resolveGeminiModel(config).apiKey, "synthetic-custom");
  }
});
