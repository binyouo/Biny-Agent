import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { SessionLeaseStore, SessionWriterConflictError } from "../src/runtime/SessionLease.js";
import { runtimeHostLaunchPlan } from "../src/runtime/host/lifecycle.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs, resolveSessionFile, sessionFilePath } from "../src/session/store.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-resume-selector-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  let host: InteractiveAgentHost | undefined;
  let observer: SessionLeaseStore | undefined;
  let networkRequests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    networkRequests += 1;
    throw new Error("Unexpected network request during historical resume");
  });
  t.after(async () => {
    try {
      await host?.runtime.close();
    } finally {
      observer?.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(networkRequests, 0, "history recovery must not call a model or network");
  });
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.defaultModel = "fixture";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { fixture: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "fixture" } };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.extensions.skills = [];
  config.extensions.plugins = [];
  config.extensions.globalPlugins = [];
  config.extensions.mcp = {};
  config.extensions.subagent.enabled = false;
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  await configStore.save(config);
  const a = "history-a";
  const b = "history-b";
  for (const sessionId of [a, b]) {
    const recorder = new SessionRecorder(root, sessionId);
    try {
      recorder.record({ type: "user_message", content: `request ${sessionId}` });
      recorder.record({ type: "assistant_message", content: `answer ${sessionId}` });
    } finally {
      await recorder.close();
    }
  }
  // Match production startup: create a fresh draft, then resume the saved session.
  // Never construct the fresh runtime with a historical session's ID.
  host = await createInteractiveAgentHost(root, { configStore });
  observer = await SessionLeaseStore.open(root);
  const aPath = sessionFilePath(root, a);
  const bPath = sessionFilePath(root, b);
  const bBefore = await readFile(bPath);
  const epoch = Date.now() + 60_000;
  await utimes(bPath, new Date(epoch), new Date(epoch));
  await utimes(aPath, new Date(epoch + 10_000), new Date(epoch + 10_000));
  assert.equal(await resolveSessionFile(root, "latest"), aPath);
  return { root, host, observer, a, b, aPath, bPath, bBefore,
    async makeBLatest() {
      await utimes(bPath, new Date(epoch + 20_000), new Date(epoch + 20_000));
      assert.ok((await stat(bPath)).mtimeMs > (await stat(aPath)).mtimeMs);
      assert.equal(await resolveSessionFile(root, "latest"), bPath);
    }
  };
}

for (const scenario of ["latest changes", "explicit ID", "stable latest"] as const) {
  test(`resume binds content to its claimed source when ${scenario}`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const claimed: string[] = [];
    const claim = f.host.runtime.claimSession.bind(f.host.runtime);
    t.mock.method(f.host.runtime, "claimSession", async (session: string) => {
      await claim(session);
      claimed.push(session);
      // The real claim has completed; only change the independently selectable source.
      // This is the public await boundary before maintenance starts AgentSession.resume.
      if (scenario !== "stable latest") await f.makeBLatest();
    });
    const resumed = await f.host.runtime.resumeSession(scenario === "explicit ID" ? f.a : "latest");
    assert.deepEqual(claimed, [f.a]);
    assert.equal(resumed.sessionId, f.a, "resumed identity must match the session already claimed");
    assert.equal(resumed.filePath, f.aPath);
    assert.equal(f.host.runtime.getSnapshot().info.sessionId, f.a);
    assert.equal(f.host.commands.agent.getSessionRecorder().filePath, f.aPath);
    const history = resumed.events.filter(event => event.type === "user_message" || event.type === "assistant_message");
    assert.deepEqual(history.map(event => event.content), [`request ${f.a}`, `answer ${f.a}`]);
    assert.deepEqual(await readFile(f.bPath), f.bBefore, "selection changes must not rewrite B");
    assert.throws(() => f.observer.acquire(f.a), (error: unknown) => {
      assert.ok(error instanceof SessionWriterConflictError);
      assert.equal(error.sessionId, f.a);
      return true;
    });
    f.observer.acquire(f.b).close();
    await f.host.runtime.close();
    f.observer.acquire(f.a).close();
    assert.deepEqual(await readFile(f.bPath), f.bBefore, "close must leave the unselected source unchanged");
  });
}

test("resume rejects an already-owned initial selection before entering AgentSession", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const initialSession = f.host.runtime.getSnapshot().info.sessionId;
  const externalClaim = f.observer.acquire(f.a);
  let resumes = 0;
  const resume = f.host.commands.agent.resume.bind(f.host.commands.agent);
  t.mock.method(f.host.commands.agent, "resume", async (session: string | undefined) => {
    resumes += 1;
    return await resume(session);
  });
  try {
    await assert.rejects(f.host.runtime.resumeSession("latest"), (error: unknown) => {
      assert.ok(error instanceof SessionWriterConflictError);
      assert.equal(error.sessionId, f.a);
      return true;
    });
    assert.equal(resumes, 0);
    assert.equal(f.host.runtime.getSnapshot().info.sessionId, initialSession);
    assert.deepEqual(await readFile(f.bPath), f.bBefore);
  } finally {
    externalClaim.close();
  }
  await f.host.runtime.close();
  f.observer.acquire(f.a).close();
});

test("cold Host launch preserves the CLI resume selector for the runtime to resolve", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "biny-selector-launch-"));
  try {
    const plan = runtimeHostLaunchPlan("/workspace/data", {
      workspaceRoot: "/workspace/project", configDir, sessionId: "latest", entryPath: "/fixture/hostProcess.js"
    }, { platform: "linux", execPath: process.execPath });
    const index = plan.args.indexOf("--session-id");
    assert.ok(index >= 0);
    assert.equal(plan.args[index + 1], "latest");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
