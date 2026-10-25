import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { redactSecrets } from "../src/utils/redaction.js";

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
function actual(inputs: readonly string[]): string[] {
  return inputs.map(redactSecrets);
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
  const inputs = controls.flatMap(value => [value, begin + value + end, value + begin + fake + end + value,
    begin + fake + end + value + begin + fake, JSON.stringify({ password: value, content: begin + fake + end })]);
  const correctedInput = JSON.stringify({ password: '"password":"FAKE_PLACEHOLDER_ONLY"', content: begin + fake + end });
  const unchanged = inputs.filter(input => input !== correctedInput);
  assert.equal(inputs.length, 30);
  assert.equal(unchanged.length, 29);
  compare(unchanged);
});

test("quoted-value correction fully masks the existing escaped-password PEM interaction", () => {
  // Preserve the original input, but do not preserve its formerly leaked suffix.
  const input = JSON.stringify({ password: '"password":"FAKE_PLACEHOLDER_ONLY"', content: begin + fake + end });
  assert.equal(actual([input])[0], '{"password":"[redacted]","content":"[redacted private key]"}');
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

test("real redactor bounds repeated complete and unmatched PEM markers", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { redactSecrets } from "./src/utils/redaction.ts";
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";
    const input = (begin + "FAKE_ONLY_").repeat(120000);
    assert.equal(redactSecrets(input), input);
    assert.equal(redactSecrets((begin + "FAKE" + end).repeat(24000)), "[redacted private key]".repeat(24000));
    const ordinary = "x".repeat(24000 * 37);
    assert.equal(redactSecrets(ordinary), ordinary);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
