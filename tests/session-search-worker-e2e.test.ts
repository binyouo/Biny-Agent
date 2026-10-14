import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectSessionsDir } from "../src/config/paths.js";

test("built Electron history worker and compiled CLI retain colliding workspace sources and close normally", {
  skip: process.platform !== "darwin", timeout: 40_000
}, async () => {
  const workerEntry = fileURLToPath(new URL("../out/main/searchIndexWorker.js", import.meta.url));
  const cliEntry = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
  await access(workerEntry);
  await access(cliEntry);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-built-search-worker-")));
  const agentDir = path.join(root, "agent");
  const files: string[] = [];
  const transcripts = ["artifactsharedmarker first workspace", "artifactsharedmarker second workspace"].map(content =>
    `${JSON.stringify({ type: "user_message", messageId: "shared-message", content, time: "2026-10-14T00:00:00Z" })}\n`);
  const env = { ...process.env, BINY_AGENT_DIR: agentDir, BINY_TEST_PROCESS: "1" };
  try {
    for (const [position, transcript] of transcripts.entries()) {
      const workspace = path.join(root, `workspace-${position}`);
      await mkdir(workspace);
      const directory = projectSessionsDir(workspace, { env });
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "shared-session.jsonl");
      files.push(file);
      await writeFile(file, transcript);
    }
    const electronProbe = `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { Worker } from "node:worker_threads";
      assert.ok(process.versions.electron, "The worker must run under Electron's Node runtime");
      const worker = new Worker(${JSON.stringify(workerEntry)}, {
        workerData: { agentRoot: ${JSON.stringify(agentDir)} }, execArgv: []
      });
      const exited = once(worker, "exit");
      void exited.catch(() => undefined);
      let closed = false;
      try {
        const files = ${JSON.stringify(files)};
        const counts = [];
        for (const [position, filePath] of [...files, ...files].entries()) {
          const reply = once(worker, "message");
          worker.postMessage({ type: "index", id: position + 1, sessionId: "shared-session", filePath });
          const [message] = await reply;
          assert.equal(message.id, position + 1);
          assert.equal(message.error, undefined, JSON.stringify(message.error));
          counts.push(message.count);
        }
        worker.postMessage({ type: "close" });
        const [exitCode] = await exited;
        assert.equal(exitCode, 0);
        closed = true;
        process.stdout.write(JSON.stringify({ electron: process.versions.electron, counts, exitCode }) + "\\n");
      } finally {
        if (!closed) await worker.terminate();
      }
    `;
    const electron = createRequire(import.meta.url)("electron") as string;
    const workerResult = await promisify(execFile)(electron, ["--input-type=module", "--eval", electronProbe], {
      cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024
    });
    const workerOutput = JSON.parse(workerResult.stdout.trim()) as { electron: string; counts: number[]; exitCode: number };
    assert.ok(workerOutput.electron);
    assert.deepEqual(workerOutput.counts, [1, 1, 0, 0]);
    assert.equal(workerOutput.exitCode, 0);
    const cliResult = await promisify(execFile)(process.execPath, [cliEntry, "history", "search", "artifactsharedmarker", "--json"], {
      cwd: root, env, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(cliResult.stdout.trim()) as {
      query: string; hits: Array<{ sessionId: string; messageId: string; sourcePath: string; excerpt: string }>
    };
    assert.equal(result.query, "artifactsharedmarker");
    assert.equal(result.hits.length, 2);
    assert.deepEqual(result.hits.map(hit => hit.sourcePath).sort(), [...files].sort());
    assert.ok(result.hits.every(hit => hit.sessionId === "shared-session" && hit.messageId === "shared-message"));
    assert.deepEqual(result.hits.map(hit => hit.excerpt).sort(), ["artifactsharedmarker first workspace", "artifactsharedmarker second workspace"]);
    for (const [position, file] of files.entries()) assert.equal(await readFile(file, "utf8"), transcripts[position]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
