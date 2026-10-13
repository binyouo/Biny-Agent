import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient, type AcpSessionInfo } from "../src/acp/client.js";
import { acpConfigSchema } from "../src/acp/config.js";

type ConnectOutcome = { kind: "fulfilled"; info: AcpSessionInfo } | { kind: "rejected"; error: unknown } | { kind: "watchdog" };

async function observeAndClose(client: AcpClient, connecting: Promise<AcpSessionInfo>, timeoutMs: number): Promise<ConnectOutcome> {
  const observed = connecting.then(
    (info): ConnectOutcome => ({ kind: "fulfilled", info }),
    (error: unknown): ConnectOutcome => ({ kind: "rejected", error })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<ConnectOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "watchdog" }), timeoutMs);
  });
  try {
    return await Promise.race([observed, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.close(); }
    finally { await observed; }
  }
}

async function handledMethods(logFile: string): Promise<string[]> {
  let log: string;
  try { log = await readFile(logFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return log.split("\n").filter(Boolean).map((line) => {
    const message = JSON.parse(line) as { method?: string };
    return message.method ?? "";
  });
}

test("ACP startup aborted across initial close rejects before initialization or session creation", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-startup-abort-"));
  const logFile = path.join(root, "protocol.jsonl");
  const bindingFile = path.join(root, "binding.json");
  const previous = process.env.BINY_ACP_STARTUP_ABORT_LOG;
  process.env.BINY_ACP_STARTUP_ABORT_LOG = logFile;
  const client = new AcpClient({ cwd: root, bindingFile, launch: acpConfigSchema.parse({ command: process.execPath,
    args: [path.resolve("tests/fixtures/acp-agent.mjs")], env: { ACP_FIXTURE_LOG: "BINY_ACP_STARTUP_ABORT_LOG" } }) });
  try {
    const controller = new AbortController();
    const reason = new Error("startup cancellation witness");
    // No await or timer between connect and abort: connect is suspended at its first await close().
    const connecting = client.connect(controller.signal);
    controller.abort(reason);
    const outcome = await observeAndClose(client, connecting, 5000);
    const methods = await handledMethods(logFile);
    assert.notEqual(outcome.kind, "watchdog", "responsive fixture did not settle; this is not the expected regression witness");
    assert.equal(outcome.kind, "rejected", `cancelled startup must reject; handled methods: ${methods.join(", ")}`);
    if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
    assert.deepEqual(methods.filter((method) => method === "initialize" || method === "session/new"), [],
      "fixture must not handle initialization or session creation for the cancelled attempt");
    await assert.rejects(readFile(bindingFile), { code: "ENOENT" });

    // A later, explicitly requested connection still works and persists its own binding.
    const reconnected = await observeAndClose(client, client.connect(), 5000);
    assert.equal(reconnected.kind, "fulfilled", "a later explicit startup must succeed");
    if (reconnected.kind === "fulfilled") assert.equal(reconnected.info.sessionId, "fixture-session");
    assert.deepEqual((await handledMethods(logFile)).filter((method) => method === "initialize" || method === "session/new"),
      ["initialize", "session/new"]);
    const binding = JSON.parse(await readFile(bindingFile, "utf8")) as { sessionId: string };
    assert.equal(binding.sessionId, "fixture-session");
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.BINY_ACP_STARTUP_ABORT_LOG; else process.env.BINY_ACP_STARTUP_ABORT_LOG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP startup abort before subscription cannot leave a hung adapter beyond its startup deadline", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-startup-hung-"));
  const client = new AcpClient({ cwd: root, timeoutMs: 100, launch: acpConfigSchema.parse({ command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"] }) });
  try {
    const controller = new AbortController();
    const reason = new Error("hung startup cancellation witness");
    const connecting = client.connect(controller.signal);
    controller.abort(reason);
    // This timer bounds a failed observation; it does not arrange the cancellation window.
    const outcome = await observeAndClose(client, connecting, 1000);
    assert.equal(outcome.kind, "rejected", "cancelled startup must settle without the independent watchdog");
    if (outcome.kind === "rejected") assert.equal(outcome.error, reason);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
