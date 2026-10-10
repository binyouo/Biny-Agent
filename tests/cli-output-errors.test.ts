/** Failed output delivery must be observable to scripts without interrupting runtime cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfigFile } from "../src/config/loader.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-output-errors-"));
const agent = path.join(root, "agent");
const entry = path.resolve("src/cli/index.ts");
const preload = path.join(root, "output-fault.mjs");
// Only the external Writable boundary is replaced; console, CLI, runtime and storage stay real.
await writeFile(preload, `
for (const stream of process.env.BINY_TEST_FAILED_OUTPUT.split(",")) {
  if (!stream) continue;
  process[stream]._write = (_chunk, _encoding, callback) => callback(
    Object.assign(new Error("synthetic output device full"), { code: "ENOSPC" })
  );
}
if (process.env.BINY_TEST_STDERR_PROBE === "1") {
  process.once("beforeExit", () => process.stderr.write("fixture warning\\n"));
}
if (process.env.BINY_TEST_EXIT_CODE) process.exitCode = Number(process.env.BINY_TEST_EXIT_CODE);
`);
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OUTPUT_MARKER" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await saveConfigFile(agent, configSchema.parse({
    ...defaultConfig,
    defaultModel: "fixture",
    providers: { "cli-output-fixture": { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { fixture: { provider: "cli-output-fixture", model: "fixture", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  // A stderr delivery failure must fail a command that otherwise succeeds.
  for (const fail of [false, true]) {
    const result = await run(["--version"], fail ? "stderr" : "", undefined, true);
    assert.equal(result.code, fail ? 1 : 0, "stderr output failure must promote successful status");
    assert.ok(result.stdout.trim(), "version output must remain available");
    assert.equal(result.stderr, fail ? "" : "fixture warning\n", "stderr failure must not recurse or print an unhandled error stack");
  }
  for (const json of [false, true]) {
    for (const fail of [false, true]) {
      const result = await run(["run", "--headless", ...(json ? ["--json"] : []), "Say OUTPUT_MARKER"], fail ? "stdout" : "");
      assert.equal(result.code, fail ? 1 : 0, "failed result output must not report success");
      if (fail) {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /standard output.*synthetic output device full/u);
        assert.doesNotMatch(result.stderr, /Unhandled 'error'|\n\s+at /u);
      } else if (json) {
        assert.equal((JSON.parse(result.stdout) as { status: string }).status, "completed");
      } else {
        assert.match(result.stdout, /OUTPUT_MARKER/u);
      }
      assert.deepEqual((await readdir(agent, { recursive: true })).filter((file) => file.endsWith(".lock")), [], "output errors must not prevent normal lease cleanup");
    }
  }
  // Parser exits also write asynchronously; a successful help/version status cannot hide lost output.
  for (const args of [["--help"], ["--version"], ["run", "--help"], ["help", "run"]]) {
    for (const fail of [false, true]) {
      const result = await run(args, fail ? "stdout" : "");
      assert.equal(result.code, fail ? 1 : 0, `${args.join(" ")} must report delivery status`);
      if (fail) {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /standard output.*synthetic output device full/u);
      } else {
        assert.ok(result.stdout.trim());
        assert.equal(result.stderr, "");
      }
      assert.doesNotMatch(result.stderr, /Unhandled 'error'|\n\s+at /u);
    }
  }
  for (const args of [["--not-a-real-option"], ["run", "--max-steps", "bad", "task"], ["run"]]) {
    for (const fail of [false, true]) {
      const result = await run(args, fail ? "stderr" : "");
      assert.equal(result.code, 1, "parser errors retain their nonzero status");
      assert.equal(result.stdout, "");
      if (fail) assert.equal(result.stderr, "");
      else assert.match(result.stderr, /error:/u);
      assert.doesNotMatch(result.stderr, /Unhandled 'error'|\n\s+at /u);
    }
  }
  const both = await run(["theme", "list", "--json"], "stdout,stderr");
  assert.equal(both.code, 1);
  assert.equal(both.stdout + both.stderr, "", "failed stderr must not recursively report itself");
  const prior = await run(["theme", "list", "--json"], "stdout", "7");
  assert.equal(prior.code, 7, "output reporting must preserve an existing failure status");
  const stderr = await run(["theme", "show", "missing-theme"], "stderr");
  assert.equal(stderr.code, 1);
  assert.equal(stderr.stdout + stderr.stderr, "");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
console.log("CLI output error tests passed");

async function run(args: string[], failedOutput: string, exitCode?: string, stderrProbe = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--no-warnings", "--import", preload, "--import", import.meta.resolve("tsx"), entry, ...args], {
    cwd: root,
    env: { ...process.env, HOME: root, BINY_AGENT_DIR: agent, BINY_TEST_FAILED_OUTPUT: failedOutput, BINY_TEST_EXIT_CODE: exitCode, BINY_TEST_STDERR_PROBE: stderrProbe ? "1" : "" },
    signal: AbortSignal.timeout(30_000)
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
