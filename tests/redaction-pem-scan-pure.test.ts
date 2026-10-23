import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// This frozen reference is the previous complete redactor. Differential checks
// cover the complete chain, not just the private-key replacement in isolation.
function reference(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;；，、]+/gi, "Bearer [redacted]")
    .replace(/((?:aws_secret_access_key|_authToken)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)([^\s,;；，、]+)/gi, "$1[redacted]")
    .replace(/(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*["'])([^"']*)(["'])/gi, "$1[redacted]$3");
}
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
    const receiver = callee.expression.getText(source);
    const member = callee.name.text;
    assert.ok(member === "replace" && replaceRoot(callee.expression)
      || member === "exec" && ["beginPattern", "endPattern"].includes(receiver)
      || member === "slice" && receiver === "value"
      || ["push", "join"].includes(member) && receiver === "parts", `unreviewed call: ${callee.getText(source)}`);
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
  try { return Array.from(batch.runInContext(context, { timeout: 1_000 }) as string[]); }
  finally { delete context.inputs; }
}
function compare(inputs: readonly string[]): void {
  assert.deepEqual(actual(inputs), inputs.map(reference));
}
const begin = "-----BEGIN PRIVATE KEY-----";
const end = "-----END PRIVATE KEY-----";
const fake = "FAKE_PLACEHOLDER_ONLY";

test("complete, adjacent, nested, and mismatched labels match the previous full redactor", () => {
  compare(["", "ordinary😀", begin + end, begin + fake + end, begin + begin + fake + end + end,
    end + begin + fake + end, begin + fake + end + begin + fake + end,
    "-----BEGIN RSA PRIVATE KEY-----" + fake + "-----END EC PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEYPRIVATE KEY-----" + fake + end,
    "-----BEGIN 😀 PRIVATE KEY-----" + fake + "-----END OTHER PRIVATE KEY-----"]);
});

test("malformed markers, header line breaks, case, and unfinished tails remain unchanged", () => {
  compare([begin, end, begin + fake, "prefix" + begin + end + "suffix" + begin + fake,
    "-----begin PRIVATE KEY-----" + fake + end,
    "-----BEGIN private key-----" + fake + end,
    "-----BEGIN RSA-PRIVATE KEY-----" + fake + end,
    "-----BEGIN RSA\nPRIVATE KEY-----" + fake + end,
    "-----BEGIN RSA\rPRIVATE KEY-----" + fake + end,
    begin + fake + "-----END RSA\nPRIVATE KEY-----",
    begin + "\r\n😀" + end, "----" + begin + fake + end + "------"]);
});

test("the remaining redaction rules retain their order around PEM blocks", () => {
  const controls = ["Bearer FAKE_PLACEHOLDER_ONLY", "token=FAKE_PLACEHOLDER_ONLY；public", '"password":"FAKE_PLACEHOLDER_ONLY"',
    "aws_secret_access_key=FAKE_PLACEHOLDER_ONLY", "_authToken=FAKE_PLACEHOLDER_ONLY", "sk_FAKEPLACEHOLDERONLY"];
  compare(controls.flatMap(value => [value, begin + value + end, value + begin + fake + end + value,
    begin + fake + end + value + begin + fake, JSON.stringify({ password: value, content: begin + fake + end })]));
});

test("bounded exhaustive delimiter combinations preserve the complete result", () => {
  const tokens = ["", "x", "😀", "\r", "\n", "-----", begin, end,
    "-----BEGIN RSA PRIVATE KEY-----", "-----END EC PRIVATE KEY-----",
    "-----BEGIN X-PRIVATE KEY-----", "-----END X\nPRIVATE KEY-----",
    "-----begin PRIVATE KEY-----", "-----BEGIN ", "PRIVATE KEY-----", "token=FAKE;"];
  const inputs: string[] = [];
  for (const a of tokens) for (const b of tokens) for (const c of tokens) inputs.push(a + b + c);
  compare(inputs);
  assert.equal(inputs.length, 4_096);
});

test("deterministic generated longer mixtures preserve the complete result", () => {
  const tokens = [begin, end, fake, "-----BEGIN RSA PRIVATE KEY-----", "-----END EC PRIVATE KEY-----",
    "-----BEGIN ", "PRIVATE KEY-----", "-----END ", "\r\n", "😀", "-", "token=FAKE;", '"secret":"FAKE"', "-----begin PRIVATE KEY-----"];
  let seed = 0x51c0ffee;
  const next = (): number => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
  const inputs = Array.from({ length: 5_000 }, () => {
    const count = 1 + next() % 20;
    return Array.from({ length: count }, () => tokens[next() % tokens.length]!).join("");
  });
  compare(inputs);
});

test("bounded ordinary and complete-marker ladders finish within the VM ceiling", () => {
  for (const count of [8_000, 16_000, 24_000]) {
    const ordinary = "x".repeat(count * 37);
    assert.equal(actual([ordinary])[0], ordinary);
    assert.equal(actual([(begin + fake + end).repeat(count)])[0], "[redacted private key]".repeat(count));
  }
});

test("bounded repeated unmatched markers finish within the VM ceiling", () => {
  // The previous regex rescans the remaining suffix for each BEGIN. The fixed
  // one-second ceiling bounds this synthetic regression; it is not a benchmark.
  for (const count of [8_000, 16_000, 24_000]) {
    const input = (begin + "FAKE_ONLY_").repeat(count);
    assert.equal(actual([input])[0], input);
  }
});
