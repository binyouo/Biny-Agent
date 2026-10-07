import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/loader.js";
import { defaultConfig } from "../src/config/schema.js";

const entry = path.resolve("src/cli/index.ts");
function testConfig() {
  const providerAlias = `doctor-${randomUUID()}`;
  return {
    ...structuredClone(defaultConfig),
    defaultModel: "doctor-model",
    providers: {
      [providerAlias]: {
        type: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnv: `BINY_DOCTOR_TEST_${randomUUID().replaceAll("-", "_")}`,
        apiKey: undefined as string | undefined
      }
    },
    models: { "doctor-model": { provider: providerAlias, model: "doctor-model" } },
    thinking: { ...defaultConfig.thinking, enabled: false }
  };
}

for (const scenario of [
  {
    name: "malformed project settings",
    project: '{"thinking": ',
    diagnostic: /Invalid project \.biny\/settings\.json/u,
    safeDiagnostic: "Invalid project .biny/settings.json. Check JSON syntax and supported field values."
  },
  {
    name: "invalid project field types",
    project: '{"thinking":{"enabled":"yes"}}',
    diagnostic: /Invalid project \.biny\/settings\.json:[\s\S]*Expected boolean/u,
    safeDiagnostic: "Invalid project .biny/settings.json. Check JSON syntax and supported field values."
  },
  {
    name: "a project model alias missing from global models",
    project: '{"defaultModel":"missing-project-model"}',
    diagnostic: /Project defaultModel "missing-project-model" is not configured/u,
    safeDiagnostic: "Project .biny/settings.json defaultModel must reference a model configured in global config.json."
  },
  {
    name: "an invalid alias discovered only after merging project settings",
    project: '{"context":{"compaction":{"summaryModel":"missing-summary-model"}}}',
    diagnostic: /Unknown compaction summary model alias: missing-summary-model/u,
    safeDiagnostic: "Invalid effective configuration. Check field values and model references in global config.json and project .biny/settings.json."
  },
  {
    name: "malformed global configuration",
    global: '{"thinking": ',
    diagnostic: /Failed to load config\.json/u,
    safeDiagnostic: "Unable to read or validate global config.json. Check file access, JSON syntax, supported field values and model references."
  },
  {
    name: "invalid global model references",
    global: JSON.stringify({ ...testConfig(), defaultModel: "missing-global-model" }),
    diagnostic: /Unknown default model alias: missing-global-model/u,
    safeDiagnostic: "Unable to read or validate global config.json. Check file access, JSON syntax, supported field values and model references."
  }
]) {
  test(`doctor fails with an actionable diagnostic for ${scenario.name}`, async () => {
    await fixture(scenario, async ({ workspace, globalDir, run }) => {
      // The real startup loader rejects the same files; merely reporting their presence is insufficient.
      await assert.rejects(loadConfig(workspace, { globalDir }), scenario.diagnostic);
      const result = run();
      assert.ok(result.stderr.includes(scenario.safeDiagnostic), "doctor must identify the configuration source and repair direction without echoing its values");
      assert.equal(result.status, 1, "a configuration rejected at startup must fail the diagnostic command");
      assert.match(result.stdout, /^node: v/mu, "configuration errors must not hide the other local checks");
      assert.doesNotMatch(result.stdout, /configuration: valid/u);
      assert.doesNotMatch(result.stderr, /\n\s+at /u, "configuration errors use the concise CLI error path");
    });
  });
}

test("doctor reports an unreadable project settings entry without replacing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-doctor-config-entry-"));
  const workspace = path.join(root, "workspace");
  const globalDir = path.join(root, "agent");
  const projectPath = path.join(workspace, ".biny", "settings.json");
  try {
    await mkdir(projectPath, { recursive: true });
    await assert.rejects(loadConfig(workspace, { globalDir }), /must be a single-link regular file/u);
    const result = runDoctor(workspace, globalDir);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Unable to read project .biny/settings.json. Check file access, file type and size."));
    assert.doesNotMatch(result.stdout, /configuration: valid/u);
    assert.deepEqual(await readdir(projectPath), [], "doctor must preserve the invalid entry for the user to repair");
    assert.deepEqual(await readdir(root), ["workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const target of ["global", "project"] as const) {
  for (const document of [
    { kind: "schema values", bytes: '{"thinking":{"effort":"sk_SYNTHETIC_PRIVATE_VALUE"}}', forbidden: /sk_SYNTHETIC_PRIVATE_VALUE/u },
    { kind: "malformed JSON excerpts", bytes: '{"apiKey": skSYNTHETICSECRET}', forbidden: /skSYNTHETI/u }
  ]) {
    test(`doctor never prints ${target} ${document.kind} in validation errors`, async () => {
      await fixture({ [target]: document.bytes }, async ({ run }) => {
        const result = run();
        assert.equal(result.status, 1);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, document.forbidden);
        assert.match(result.stderr, target === "global" ? /config\.json/u : /\.biny\/settings\.json/u);
        assert.doesNotMatch(result.stdout, /configuration: valid/u);
      });
    });
  }
}

test("doctor accepts valid sparse overrides without requiring a live provider or credentials", async () => {
  await fixture({ global: JSON.stringify(testConfig()), project: '{"thinking":{"enabled":false}}' }, async ({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^configuration: valid$/mu);
    assert.match(result.stdout, /^credentials: no inline API keys$/mu);
  });
});

test("doctor preserves inline-key warnings without printing the credential value", async () => {
  const syntheticKey = "doctor-test-inline-value";
  const config = testConfig();
  Object.values(config.providers)[0]!.apiKey = syntheticKey;
  await fixture({ global: JSON.stringify(config) }, async ({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^configuration: valid$/mu);
    assert.match(result.stdout, /credentials: warning: inline API key found/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /doctor-test-inline-value/u);
  });
});

test("doctor accepts missing optional files and ignores the legacy project config without creating state", async () => {
  await fixture({ legacy: '{"not-active": ' }, async ({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^configuration: valid$/mu);
    assert.match(result.stdout, /ignored legacy config: found at .*; ignored and not loaded/u);
    assert.match(result.stdout, /settings\.json: missing/u);
    assert.match(result.stdout, /^\.biny: missing$/mu);
  });
});

async function fixture(
  documents: { global?: string; project?: string; legacy?: string },
  run: (state: { workspace: string; globalDir: string; run: () => ReturnType<typeof runDoctor> }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-doctor-config-"));
  const workspace = path.join(root, "workspace");
  const globalDir = path.join(root, "agent");
  const files: [string, string | undefined][] = [
    [path.join(globalDir, "config.json"), documents.global],
    [path.join(workspace, ".biny", "settings.json"), documents.project],
    [path.join(workspace, "config.json"), documents.legacy]
  ];
  try {
    await mkdir(workspace);
    for (const [filePath, bytes] of files) {
      if (bytes === undefined) continue;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes, { mode: 0o600 });
    }
    await run({ workspace, globalDir, run: () => runDoctor(workspace, globalDir) });
    for (const [filePath, bytes] of files) {
      if (bytes === undefined) await assert.rejects(readFile(filePath), { code: "ENOENT" });
      else assert.equal(await readFile(filePath, "utf8"), bytes, "doctor must not rewrite configuration files");
    }
    if (documents.global === undefined) await assert.rejects(readdir(globalDir), { code: "ENOENT" });
    else assert.deepEqual(await readdir(globalDir), ["config.json"], "doctor must not create runtime or session state");
    assert.deepEqual(await readdir(workspace), [
      ...(documents.project === undefined ? [] : [".biny"]),
      ...(documents.legacy === undefined ? [] : ["config.json"])
    ]);
    if (documents.project !== undefined) assert.deepEqual(await readdir(path.join(workspace, ".biny")), ["settings.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runDoctor(workspace: string, globalDir: string) {
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry, "doctor"], {
    cwd: workspace,
    env: { ...process.env, BINY_AGENT_DIR: globalDir },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
