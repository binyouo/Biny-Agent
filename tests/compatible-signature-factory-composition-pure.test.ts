/** Pure factory wiring and signature projection only; no product imports or SDK/network execution. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const factoryRoot = process.env.BINY_SIGNATURE_FACTORY_SOURCE_ROOT ?? root;
function declarations(file: string, names: readonly string[]): string {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const matches = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    assert.equal(matches.length, 1, name);
    const node = matches[0]!;
    function audit(child: ts.Node): void {
      assert.ok(!ts.isImportDeclaration(child) && !ts.isImportEqualsDeclaration(child) && child.kind !== ts.SyntaxKind.ImportKeyword);
      if (ts.isIdentifier(child)) assert.ok(!["process", "require", "eval", "Function", "WebSocket"].includes(child.text));
      ts.forEachChild(child, audit);
    }
    audit(node);
    return node.getText(source).replace(/^export /u, "");
  }).join("\n");
}
const factoryCode = declarations(path.join(factoryRoot, "src/llm/vercelModel.ts"), ["createVercelLanguageModel"]);
const signatureCode = declarations(path.join(root, "src/llm/compatibleToolMetadata.ts"), ["withCompatibleToolMetadata", "projectCompatibleToolMetadata"]);
function evaluate<T>(code: string, bindings: Record<string, unknown>): T {
  const emitted = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true
  });
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  return new Script(emitted.outputText).runInContext(createContext(bindings, { codeGeneration: { strings: false, wasm: false } }), { timeout: 1000 }) as T;
}

type Prompt = Array<{ role: string; content: Array<Record<string, any>> }>;
interface Params { prompt: Prompt; [key: string]: unknown }
interface Model { kind: string; doGenerate(params: Params): Promise<Params>; doStream(params: Params): Promise<Params> }
interface Input { providerType: string; providerAlias?: string; api?: string; supportsReasoning?: boolean; supportsVision?: boolean }
function fixture(input: Input) {
  const constructions: Array<{ wrapper: string; inner: string; supportsVision?: boolean }> = [];
  const calls: Array<{ wire: string; model: string }> = [];
  const requests: Params[] = [];
  const makeModel = (wire: string, model: string): Model => {
    calls.push({ wire, model });
    return { kind: wire, doGenerate: async params => { requests.push(params); return params; }, doStream: async params => { requests.push(params); return params; } };
  };
  const constructor = (wire: string) => (_options: unknown) => (id: string) => makeModel(wire, id);
  const signatures = evaluate<{ withCompatibleToolMetadata(model: Model): Model }>(signatureCode + "\n;({withCompatibleToolMetadata})", {
    wrapLanguageModel({ model, middleware }: { model: Model; middleware: { transformParams(args: { params: Params }): Promise<Params> } }): Model {
      constructions.push({ wrapper: "signature", inner: model.kind });
      return {
        kind: "signature",
        doGenerate: async params => model.doGenerate(await middleware.transformParams({ params })),
        doStream: async params => model.doStream(await middleware.transformParams({ params }))
      };
    }
  });
  const factory = evaluate<(input: Record<string, unknown>) => Model>(factoryCode + "\n;createVercelLanguageModel", {
    ...signatures,
    createAnthropic: constructor("anthropic"), createGoogleGenerativeAI: constructor("google-native"),
    createOpenAICompatible: constructor("compatible"),
    createOpenAI: (_options: unknown) => ({ responses: (id: string) => makeModel("responses", id), chat: (id: string) => makeModel("openai-chat", id) }),
    // Only a seam proving preservation and order of the existing image adapter.
    // No image projection or image fixture is executed by this test.
    withChatToolImages(model: Model, supportsVision: boolean | undefined): Model {
      constructions.push({ wrapper: "images", inner: model.kind, supportsVision });
      return { ...model, kind: "images" };
    },
    createPrivacyFetch() { throw new Error("outside this factory-composition fixture"); }
  });
  const resolved = factory({ providerAlias: "renamed-gemini", api: "chat_completions", modelId: "synthetic-model", supportsReasoning: false,
    baseUrl: "https://fixture.invalid/v1", apiKey: undefined, authMode: "api-key", headers: { "user-agent": "fixture" },
    fetcher: () => { throw new Error("network is outside this fixture"); }, ...input });
  assert.equal(calls.length, 1, "construct the provider model exactly once");
  return { resolved, constructions, calls, requests };
}
function prompt(): Prompt {
  return [{ role: "assistant", content: [
    { type: "text", text: "Call the tool" },
    { type: "tool-call", toolCallId: "call-a", toolName: "inert", input: { value: "a" }, providerOptions: { oldAlias: { thoughtSignature: "signature-a", extra: 1 } } },
    { type: "tool-call", toolCallId: "call-b", toolName: "inert", input: { value: "b" }, providerOptions: { oldAlias: { thoughtSignature: "signature-b" } } }
  ] }, { role: "tool", content: [{ type: "tool-result", toolCallId: "call-a", toolName: "inert", output: { type: "text", value: "OK" } }] }];
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
for (const method of ["doGenerate", "doStream"] as const) for (const supportsVision of [undefined, false, true]) {
  test(`Gemini keeps signature projection inside image adapter: ${method}, vision=${supportsVision}`, async () => {
    const h = fixture({ providerType: "gemini", supportsVision });
    assert.deepEqual(h.constructions, [{ wrapper: "signature", inner: "compatible" }, { wrapper: "images", inner: "signature", supportsVision }]);
    const canonical = prompt(); const before = structuredClone(canonical); freeze(canonical);
    const result = await h.resolved[method]({ prompt: canonical, marker: "preserve" });
    assert.equal(h.requests.length, 1); assert.equal(result.marker, "preserve");
    const parts = result.prompt[0]!.content;
    assert.equal(parts[1]!.providerOptions.google.thoughtSignature, "signature-a");
    assert.equal(parts[2]!.providerOptions.google.thoughtSignature, "signature-b");
    assert.equal(parts[1]!.providerOptions.oldAlias.extra, 1);
    assert.equal(parts[1]!.toolCallId, "call-a"); assert.equal(parts[2]!.toolCallId, "call-b");
    assert.equal(result.prompt[1], canonical[1]); assert.deepEqual(canonical, before);
  });
}
for (const [name, input, wire, imageWrapper] of [
  ["non-Gemini compatible", { providerType: "custom" }, "compatible", true],
  ["native Google", { providerType: "gemini", api: "google_generative_ai" }, "google-native", false],
  ["Responses", { providerType: "gemini", api: "responses" }, "responses", false],
  ["Anthropic", { providerType: "gemini", api: "anthropic_messages" }, "anthropic", false],
  ["native OpenAI chat", { providerType: "openai", supportsReasoning: true }, "openai-chat", true]
] as const) for (const method of ["doGenerate", "doStream"] as const) {
  test(`preserve non-target factory route: ${name}, ${method}`, async () => {
    const h = fixture({ ...input, supportsVision: false });
    assert.equal(h.calls[0]!.wire, wire);
    assert.deepEqual(h.constructions, imageWrapper ? [{ wrapper: "images", inner: wire, supportsVision: false }] : []);
    const canonical = prompt(); freeze(canonical);
    const result = await h.resolved[method]({ prompt: canonical });
    assert.equal(result.prompt, canonical); assert.equal(h.requests.length, 1);
  });
}
test("factory composition preserves explicit/conflicting signatures", async () => {
  const h = fixture({ providerType: "gemini" });
  const canonical = prompt();
  canonical[0]!.content[1]!.providerOptions.google = { thoughtSignature: "" };
  canonical[0]!.content[2]!.providerOptions.other = { thoughtSignature: "conflict" };
  freeze(canonical);
  const result = await h.resolved.doGenerate({ prompt: canonical });
  assert.equal(result.prompt, canonical);
});
