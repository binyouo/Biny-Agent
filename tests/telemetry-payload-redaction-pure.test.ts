import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Read source, but never import telemetry, its persistence dependencies, or the
// application. Execute only the two audited pure functions with synthetic data.
function extract(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, `unique ${name}`);
  const node = nodes[0]!;
  const replaceRoot = (expression: ts.Expression): boolean => ts.isIdentifier(expression) && expression.text === "value"
    || ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "replace" && replaceRoot(expression.expression.expression);
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child) && !ts.isImportEqualsDeclaration(child) && !ts.isNewExpression(child), "no imports or constructors");
    if (ts.isCallExpression(child)) {
      const expression = child.expression;
      const allowed = ts.isIdentifier(expression) && expression.text === "redactSecrets"
        || ts.isPropertyAccessExpression(expression) && (
          expression.name.text === "stringify" && expression.expression.getText(source) === "JSON"
          || expression.name.text === "replace" && replaceRoot(expression.expression)
          || expression.name.text === "exec" && ["beginPattern", "endPattern", "legacyQuotedPattern", "completeQuotedPattern"].includes(expression.expression.getText(source))
          || expression.name.text === "slice" && expression.expression.getText(source) === "value"
          || expression.name.text === "push" && ["parts", "legacySpans", "completeSpans", "quotedParts"].includes(expression.expression.getText(source))
          || expression.name.text === "join" && ["parts", "quotedParts"].includes(expression.expression.getText(source))
          || expression.name.text === "slice" && ts.isCallExpression(expression.expression)
            && ["JSON.stringify", "redactSecrets"].includes(expression.expression.expression.getText(source)));
      assert.ok(allowed, `unreviewed call: ${expression.getText(source)}`);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return node.getText(source).replace(/^export /u, "");
}
const root = process.cwd();
const program = [
  extract(path.join(root, "src/utils/redaction.ts"), "redactSecrets"),
  extract(path.join(root, "src/observability/telemetry.ts"), "safePayload")
].join("\n");
const compiled = ts.transpileModule(program, { reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(compiled.outputText).runInContext(context, { timeout: 1_000 });
const invoke = new Script("safePayload(input)");
function payload(input: unknown): string | undefined {
  context.input = input;
  try {
    return invoke.runInContext(context, { timeout: 1_000 }) as string | undefined;
  } finally {
    delete context.input;
  }
}

const fake = "FAKE_PLACEHOLDER_ONLY_";
for (const key of ["apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token", "token", "secret", "password"]) {
  test(`redacts ${key} when its closing quote is beyond the cap`, () => {
    const value = Object.freeze({ prefix: "x".repeat(7_900), [key]: fake.repeat(20), suffix: "tail" });
    const before = JSON.stringify(value);
    assert.ok(before.indexOf(fake) < 8_000 && before.lastIndexOf(fake) > 8_000);
    const actual = payload(value)!;
    assert.doesNotMatch(actual, /FAKE_PLACEHOLDER_ONLY/u);
    assert.equal(actual, JSON.stringify({ ...value, [key]: "[redacted]" }).slice(0, 8_000));
    assert.equal(JSON.stringify(value), before);
  });
}

test("redacts a synthetic PEM block whose closing delimiter crosses the cap", () => {
  const input = "x".repeat(7_900) + "-----BEGIN PRIVATE KEY-----" + fake.repeat(20) + "-----END PRIVATE KEY-----tail";
  const serialized = JSON.stringify(input);
  assert.ok(serialized.indexOf(fake) < 8_000 && serialized.indexOf("-----END") > 8_000);
  assert.equal(payload(input), JSON.stringify("x".repeat(7_900) + "[redacted private key]tail"));
});

test("short recognized secrets retain existing redaction", () => {
  assert.equal(payload({ password: fake, token: fake }), '{"password":"[redacted]","token":"[redacted]"}');
  assert.equal(payload("Bearer FAKE_PLACEHOLDER_ONLY"), '"Bearer [redacted]');
  assert.equal(payload("-----BEGIN PRIVATE KEY-----FAKE_PLACEHOLDER_ONLY-----END PRIVATE KEY-----"), '"[redacted private key]"');
});

test("nonsecret payloads retain the serialized UTF-16 prefix and cap", () => {
  for (const input of [null, false, 12, "", "x".repeat(7_998), "x".repeat(7_999), "x".repeat(20_000), "x".repeat(7_998) + "😀", "😀".repeat(5_000)]) {
    const actual = payload(input)!;
    assert.equal(actual, JSON.stringify(input).slice(0, 8_000));
    assert.ok(actual.length <= 8_000);
  }
});

test("redaction expansion is also capped at 8000 UTF-16 units", () => {
  const input = "x".repeat(7_988) + " token=z";
  const expected = ('"' + "x".repeat(7_988) + " token=[redacted]").slice(0, 8_000);
  assert.equal(payload(input), expected);
  assert.equal(payload(input)!.length, 8_000);
});

test("undefined and unserializable values retain existing fallback semantics", () => {
  assert.equal(payload(undefined), undefined);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (const input of [circular, 1n, { value: 1n }, Symbol("synthetic"), () => undefined]) {
    assert.equal(payload(input), "[unserializable]");
  }
  assert.equal(payload({ omitted: undefined }), "{}");
});
