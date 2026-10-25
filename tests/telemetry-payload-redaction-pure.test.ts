import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { agentDir } from "../src/session/store.js";
import { recordNativeTelemetry } from "../src/observability/telemetry.js";

async function payload(input: unknown): Promise<string | undefined> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-telemetry-redaction-"));
  const directory = agentDir(workspace);
  try {
    await mkdir(directory, { recursive: true });
    await recordNativeTelemetry({ ...defaultConfig, telemetry: { enabled: true, recordInputs: true, recordOutputs: true } },
      workspace, { type: "start", provider: "fixture", modelId: "fixture", input });
    const lines = (await readFile(path.join(directory, "telemetry.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]!);
    assert.equal(row.type, "start");
    return row.input;
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

const fake = "FAKE_PLACEHOLDER_ONLY_";
for (const key of ["apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token", "token", "secret", "password"]) {
  test(`redacts ${key} when its closing quote is beyond the cap`, async () => {
    const value = Object.freeze({ prefix: "x".repeat(7_900), [key]: fake.repeat(20), suffix: "tail" });
    const before = JSON.stringify(value);
    assert.ok(before.indexOf(fake) < 8_000 && before.lastIndexOf(fake) > 8_000);
    const actual = (await payload(value))!;
    assert.doesNotMatch(actual, /FAKE_PLACEHOLDER_ONLY/u);
    assert.equal(actual, JSON.stringify({ ...value, [key]: "[redacted]" }).slice(0, 8_000));
    assert.equal(JSON.stringify(value), before);
  });
}

test("redacts a synthetic PEM block whose closing delimiter crosses the cap", async () => {
  const input = "x".repeat(7_900) + "-----BEGIN PRIVATE KEY-----" + fake.repeat(20) + "-----END PRIVATE KEY-----tail";
  const serialized = JSON.stringify(input);
  assert.ok(serialized.indexOf(fake) < 8_000 && serialized.indexOf("-----END") > 8_000);
  assert.equal((await payload(input)), JSON.stringify("x".repeat(7_900) + "[redacted private key]tail"));
});

test("short recognized secrets retain existing redaction", async () => {
  assert.equal((await payload({ password: fake, token: fake })), '{"password":"[redacted]","token":"[redacted]"}');
  assert.equal((await payload("Bearer FAKE_PLACEHOLDER_ONLY")), '"Bearer [redacted]');
  assert.equal((await payload("-----BEGIN PRIVATE KEY-----FAKE_PLACEHOLDER_ONLY-----END PRIVATE KEY-----")), '"[redacted private key]"');
});

test("nonsecret payloads retain the serialized UTF-16 prefix and cap", async () => {
  for (const input of [null, false, 12, "", "x".repeat(7_998), "x".repeat(7_999), "x".repeat(20_000), "x".repeat(7_998) + "😀", "😀".repeat(5_000)]) {
    const actual = (await payload(input))!;
    assert.equal(actual, JSON.stringify(input).slice(0, 8_000));
    assert.ok(actual.length <= 8_000);
  }
});

test("redaction expansion is also capped at 8000 UTF-16 units", async () => {
  const input = "x".repeat(7_988) + " token=z";
  const expected = ('"' + "x".repeat(7_988) + " token=[redacted]").slice(0, 8_000);
  assert.equal((await payload(input)), expected);
  assert.equal((await payload(input))!.length, 8_000);
});

test("undefined and unserializable values retain existing fallback semantics", async () => {
  assert.equal((await payload(undefined)), undefined);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (const input of [circular, 1n, { value: 1n }, Symbol("synthetic"), () => undefined]) {
    assert.equal((await payload(input)), "[unserializable]");
  }
  assert.equal((await payload({ omitted: undefined })), "{}");
});

for (const key of ["apiKey", "api_key", "accessToken", "access_token", "refreshToken", "refresh_token", "token", "secret", "password"]) {
  test(`persisted ${key} is fully masked across opposite and escaped quotes`, async () => {
    for (const secret of ["SYNTH_A'SYNTH_B", 'SYNTH_A"SYNTH_B', 'SYNTH_A\\"SYNTH_B']) {
      const recorded = await payload({ [key]: secret, public: "VISIBLE" });
      assert.deepEqual(JSON.parse(recorded!), { [key]: "[redacted]", public: "VISIBLE" });
    }
  });
}
