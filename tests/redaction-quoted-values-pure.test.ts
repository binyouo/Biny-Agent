import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { redactSecrets } from "../src/utils/redaction.js";

function actual(inputs: readonly string[]): string[] {
  return inputs.map(redactSecrets);
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

test("quoted and malformed boundaries retain their explicit public suffixes", () => {
  const cases = [
  [
    "\"token\":\"SYNTH\" \"password\":\"SYNTH\"",
    "\"token\":\"[redacted]\" \"password\":\"[redacted]\""
  ],
  [
    "{\"token\":\"SYNTH'SUFFIX\",\"nested\":{\"password\":\"SYNTH\"},\"public\":\"VISIBLE\"}",
    "{\"token\":\"[redacted]\",\"nested\":{\"password\":\"[redacted]\"},\"public\":\"VISIBLE\"}"
  ],
  [
    "\"PaSsWoRd\" : \"SYNTH'SUFFIX\"",
    "\"PaSsWoRd\" : \"[redacted]\""
  ],
  [
    "\"password\":\"\"",
    "\"password\":\"[redacted]\""
  ],
  [
    "'password':''",
    "'password':'[redacted]'"
  ],
  [
    "\"password\":\"SYNTH'SUFFIX",
    "\"password\":\"[redacted]'SUFFIX"
  ],
  [
    "\"password\":\"SYNTH",
    "\"password\":\"SYNTH"
  ],
  [
    "\"password\":\"SYNTH\\",
    "\"password\":\"SYNTH\\"
  ],
  [
    "\"password':\"SYNTH'SUFFIX\"",
    "\"password':\"[redacted]\""
  ],
  [
    "\"label\":\"VISIBLE\"",
    "\"label\":\"VISIBLE\""
  ]
] as const;
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected);
});

test("earlier rules, fullwidth boundaries and unrelated text retain their results", () => {
  assert.deepEqual(actual(["token=SYNTH；窗口：visible", "Bearer SYNTH", "aws_secret_access_key=SYNTH", "_authToken=SYNTH",
    "-----BEGIN PRIVATE KEY-----\nSYNTH\n-----END PRIVATE KEY-----", "sk_SYNTHETIC_ONLY", '"label":"SYNTH\'VISIBLE"']),
  ["token=[redacted]；窗口：visible", "Bearer [redacted]", "aws_secret_access_key=[redacted]", "_authToken=[redacted]",
    "[redacted private key]", "[redacted]", '"label":"SYNTH\'VISIBLE"']);
});

test("real quoted-value redactor bounds repeated malformed prefixes", () => {
  const patterns = ['"password":"\\', "'password':'\\", '"password":"' + '\\"'.repeat(5),
    '"password":"' + "'token':'\\", '"token":"\'"password":"SYNTH"', '"password":"SYNTH",'];
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { redactSecrets } from "./src/utils/redaction.ts";
    for (const pattern of ${JSON.stringify(patterns)}) {
      assert.equal(typeof redactSecrets(pattern.repeat(16000) + "SYNTH_END"), "string");
    }
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});
