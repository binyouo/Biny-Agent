import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Only the audited, self-contained redactor executes. No application imports,
// persistence, credentials, logger, Host, network or official runner is loaded.
const file = path.join(process.cwd(), "src/utils/redaction.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const nodes = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "redactSecrets");
assert.equal(nodes.length, 1);
const replaceRoot = (node: ts.Expression): boolean => ts.isIdentifier(node) && node.text === "value"
  || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "replace" && replaceRoot(node.expression.expression);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isNewExpression(node), "no imports or constructors");
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isPropertyAccessExpression(callee), "only reviewed pure member calls");
    const receiver = callee.expression.getText(source), member = callee.name.text;
    assert.ok(member === "replace" && replaceRoot(callee.expression)
      || member === "exec" && ["beginPattern", "endPattern", "legacyQuotedPattern", "completeQuotedPattern"].includes(receiver)
      || member === "slice" && receiver === "value"
      || member === "push" && ["parts", "legacySpans", "completeSpans", "quotedParts"].includes(receiver)
      || member === "join" && ["parts", "quotedParts"].includes(receiver), `unreviewed call: ${callee.getText(source)}`);
  }
  ts.forEachChild(node, audit);
}
audit(nodes[0]!);
const compiled = ts.transpileModule(nodes[0]!.getText(source).replace(/^export /u, ""), {
  reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(compiled.outputText).runInContext(context, { timeout: 1_000 });
const batch = new Script("inputs.map(input => redactSecrets(input))");
function actual(inputs: readonly string[]): string[] {
  context.inputs = inputs;
  try { return Array.from(batch.runInContext(context, { timeout: 1_500 }) as string[]); }
  finally { delete context.inputs; }
}
const keys = ["apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token", "token", "secret", "password"];
for (const key of keys) test(`complete JSON ${key} interiors retain public fields`, () => {
  const values = ["SYNTH_A'SYNTH_B", 'SYNTH_A"SYNTH_B', 'SYNTH_A\\"SYNTH_B', "", "SYNTH 😀 ; ； , ，", "SYNTH\nVALUE"];
  for (let count = 0; count < 12; count++) for (const delimiter of ['"', "'"]) values.push("SYNTH" + "\\".repeat(count) + delimiter + "END");
  const inputs = values.map(value => JSON.stringify({ [key]: value, public: "VISIBLE" }));
  for (const output of actual(inputs)) assert.deepEqual(JSON.parse(output), { [key]: "[redacted]", public: "VISIBLE" });
});

test("single-quoted diagnostics retain their own delimiter and public suffix", () => {
  const inputs = ["{'password':'SYNTH_HEAD\"SYNTH_SUFFIX', 'label':'visible'}", "{'password':'SYNTH_HEAD\\'SYNTH_SUFFIX', 'label':'visible'}"];
  assert.deepEqual(actual(inputs), inputs.map(() => "{'password':'[redacted]', 'label':'visible'}"));
});

test("legacy malformed coverage survives the complete-first context-loss counterexample", () => {
  const input = '"token":"\'"password":"SYNTH"';
  const output = actual([input])[0]!;
  assert.doesNotMatch(output, /SYNTH/u);
  assert.equal(output, '"token":"[redacted]"password":"[redacted]"');
});

// Independent oracle: collect spans on immutable input, sort all spans, then
// assemble their union. Production must not need this sorting or a JSON parser.
function oracle(input: string): { output: string; legacy: [number, number][]; union: [number, number][] } {
  const legacy: [number, number][] = [], all: [number, number][] = [];
  const old = /(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*["'])([^"']*)(["'])/gi;
  const complete = /(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gi;
  let match: RegExpExecArray | null;
  while ((match = old.exec(input)) !== null) legacy.push([match.index + match[1]!.length, match.index + match[0].length - 1]);
  all.push(...legacy);
  while ((match = complete.exec(input)) !== null) all.push([match.index + match[1]!.length + 1, match.index + match[0].length - 1]);
  all.sort((a, b) => a[0] - b[0]);
  const union: [number, number][] = [];
  for (const span of all) {
    const last = union.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else union.push([...span]);
  }
  let offset = 0, output = "";
  for (const [start, end] of union) { output += input.slice(offset, start) + "[redacted]"; offset = end; }
  return { output: output + input.slice(offset), legacy, union };
}
function compare(inputs: string[]): void {
  const expected = inputs.map(oracle);
  assert.deepEqual(actual(inputs), expected.map(item => item.output));
  for (const item of expected) for (const [start, end] of item.legacy) assert.ok(item.union.some(([a, b]) => a <= start && b >= end), "every legacy-covered original character stays masked");
}

test("adjacent, nested, mixed-case, empty and malformed quoted fragments preserve coverage", () => {
  compare(['"token":"SYNTH" "password":"SYNTH"', '{"token":"SYNTH\'SUFFIX","nested":{"password":"SYNTH"},"public":"VISIBLE"}',
    '"PaSsWoRd" : "SYNTH\'SUFFIX"', '"password":""', "'password':''", '"password":"SYNTH\'SUFFIX', '"password":"SYNTH',
    '"password":"SYNTH\\', '"password\':"SYNTH\'SUFFIX"', '"label":"VISIBLE"']);
});

test("exhaustive synthetic fragments match immutable interval union", () => {
  const fragments = ["x", '"', "'", "\\", " ", ":", '"password":"', "'password':'", '"token":"', "'token':'", "SYNTH", "[redacted]", ","];
  const inputs: string[] = [];
  for (const a of fragments) for (const b of fragments) for (const c of fragments) for (const d of fragments) inputs.push(a + b + c + d);
  assert.equal(inputs.length, 28_561);
  for (let offset = 0; offset < inputs.length; offset += 1_000) compare(inputs.slice(offset, offset + 1_000));
});

test("generated longer malformed fragments never lose legacy-covered characters", () => {
  const fragments = ["x", '"', "'", "\\", " ", ":", '"password":"', "'password':'", '"token":"', "'token':'", "SYNTH", "[redacted]", ","];
  let seed = 417;
  const next = (): number => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
  const inputs = Array.from({ length: 10_000 }, () => Array.from({ length: 4 + next() % 16 }, () => fragments[next() % fragments.length]!).join(""));
  for (let offset = 0; offset < inputs.length; offset += 1_000) compare(inputs.slice(offset, offset + 1_000));
});

test("earlier rules, fullwidth boundaries and unrelated text retain their results", () => {
  assert.deepEqual(actual(["token=SYNTH；窗口：visible", "Bearer SYNTH", "aws_secret_access_key=SYNTH", "_authToken=SYNTH",
    "-----BEGIN PRIVATE KEY-----\nSYNTH\n-----END PRIVATE KEY-----", "sk_SYNTHETIC_ONLY", '"label":"SYNTH\'VISIBLE"']),
  ["token=[redacted]；窗口：visible", "Bearer [redacted]", "aws_secret_access_key=[redacted]", "_authToken=[redacted]",
    "[redacted private key]", "[redacted]", '"label":"SYNTH\'VISIBLE"']);
});

test("bounded repeated malformed/complete prefix ladders finish inside the VM ceiling", () => {
  const patterns = ['"password":"\\', "'password':'\\", '"password":"' + '\\"'.repeat(5), '"password":"' + "'token':'\\",
    '"token":"\'"password":"SYNTH"', '"password":"SYNTH",', '"password":"\\'.repeat(2) + "'token':'\\"];
  for (const pattern of patterns) for (const count of [1_000, 4_000, 16_000]) {
    const input = pattern.repeat(count) + "SYNTH_END";
    assert.equal(actual([input])[0], oracle(input).output);
  }
});
