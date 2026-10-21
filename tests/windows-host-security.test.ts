import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { globalAgentDir, projectSessionsDir, projectStateDirName, workspaceAgentDir } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/host/bootstrap.js";
import { acquireHostLock, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { ensureAgentDirs, listSessionFiles } from "../src/session/store.js";

/** Only equality facts are logged: never print configured or resolved absolute paths. */
async function reportStatePathEquality(context: TestContext, workspace: string): Promise<void> {
  try {
    const configured = globalAgentDir();
    const syncGlobal = realpathSync(configured);
    const nativeGlobal = realpathSync.native(configured);
    const asyncGlobal = await fs.realpath(configured);
    const expectedAgent = workspaceAgentDir(workspace);
    const actualAgent = await fs.realpath(expectedAgent);
    const expectedFromNative = path.join(nativeGlobal, "workspaces", path.basename(expectedAgent));
    context.diagnostic(JSON.stringify({
      statePathEquality: {
        configuredEqualsNative: configured === nativeGlobal,
        syncEqualsNative: syncGlobal === nativeGlobal,
        asyncEqualsNative: asyncGlobal === nativeGlobal,
        globalDifferenceIsCaseOnly: syncGlobal !== nativeGlobal && syncGlobal.toLowerCase() === nativeGlobal.toLowerCase(),
        agentEqualsAsync: expectedAgent === actualAgent,
        agentDifferenceIsCaseOnly: expectedAgent !== actualAgent && expectedAgent.toLowerCase() === actualAgent.toLowerCase(),
        agentLeafEqualsAsync: path.basename(expectedAgent) === path.basename(actualAgent),
        agentParentEqualsSyncGlobal: path.dirname(expectedAgent) === path.join(syncGlobal, "workspaces"),
        asyncAgentEqualsNativeGlobalChild: actualAgent === expectedFromNative
      }
    }));
  } catch {
    // Diagnosis must never replace the original startup/contract failure.
    context.diagnostic(JSON.stringify({ statePathEqualityUnavailable: true }));
  }
}

test("endpoint permission failure refuses startup and releases the listening endpoint and owner gate", { timeout: 150_000 }, async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-endpoint-permission-")));
  const paths = runtimeHostPaths(root);
  const configDir = path.join(root, "config");
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  await configStore.save({
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    computer: { ...defaultConfig.computer, enabled: false }
  });
  const denied = new Error("synthetic endpoint permission denial");
  const servers = new Set<net.Server>();
  const realCreateServer = net.createServer;
  const createServer = context.mock.method(net, "createServer", (...args: unknown[]) => {
    const server = Reflect.apply(realCreateServer, net, args) as net.Server;
    servers.add(server);
    return server;
  });
  const realExec = childProcess.execFile;
  const realChmod = fs.chmod;
  const exec = context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv };
    if (options?.env?.BINY_IPC_PATH_KIND === "pipe") {
      queueMicrotask(() => (args[3] as (error: Error) => void)(denied));
      return new childProcess.ChildProcess();
    }
    return Reflect.apply(realExec, childProcess, args);
  });
  const chmod = context.mock.method(fs, "chmod", async (...args: Parameters<typeof fs.chmod>) => {
    if (args[0] === paths.endpoint) throw denied;
    return await realChmod(...args);
  });
  syncBuiltinESMExports();
  const probe = net.createServer((socket) => socket.destroy());
  try {
    await assert.rejects(startRuntimeHost(root, (resourceRegistry) => createInteractiveAgentHost(root, { configStore, resourceRegistry }), {createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); },  configDir }).catch(async (error: unknown) => {
      if (process.platform === "win32" && error instanceof Error && error.message === "Workspace runtime storage resolves outside the global workspace state directory.") {
        await reportStatePathEquality(context, root);
      }
      throw error;
    }), (error: unknown) => error === denied || error instanceof Error && error.cause === denied);
    await assert.rejects(fs.access(paths.registrationPath), { code: "ENOENT" });
    await assert.rejects(fs.access(paths.lockPath), { code: "ENOENT" });
    const lock = await acquireHostLock(paths, root);
    await lock.close();
    await removeTestRoot(paths.lockPath);
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(paths.endpoint, resolve); });
  } finally {
    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    createServer.mock.restore();
    exec.mock.restore(); chmod.mock.restore(); syncBuiltinESMExports();
    await removeTestRoot(root, { recursive: true, force: true });
  }
});

test("Windows workspace state accepts another casing of its own existing global directory", { skip: process.platform !== "win32" }, async (context) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "biny-state-casing-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  try {
    const canonicalRoot = await fs.realpath(root);
    const stateRoot = path.join(canonicalRoot, "MixedCaseAgentState");
    const stateAlias = path.join(canonicalRoot, "mixedcaseagentstate");
    const workspaceRoot = path.join(canonicalRoot, "Workspace");
    await fs.mkdir(stateRoot);
    await fs.mkdir(workspaceRoot);
    const workspace = await fs.realpath(workspaceRoot);
    const canonicalState = await fs.realpath(stateRoot);
    const aliasNative = realpathSync.native(stateAlias);
    const aliasAsync = await fs.realpath(stateAlias);
    // This changes only our own directory's spelling, not its destination.
    assert.ok(stateAlias !== stateRoot, "fixture must use a different non-drive component casing");
    assert.ok(aliasNative === canonicalState, "native alias must identify the created state directory");
    assert.ok(aliasAsync === canonicalState, "async alias must identify the created state directory");
    context.diagnostic(JSON.stringify({
      ordinaryDirectoryAlias: {
        syncEqualsNative: realpathSync(stateAlias) === aliasNative,
        nativeEqualsAsync: aliasNative === aliasAsync,
        aliasDifferenceIsCaseOnly: stateAlias !== canonicalState && stateAlias.toLowerCase() === canonicalState.toLowerCase()
      }
    }));
    process.env.BINY_AGENT_DIR = stateAlias;
    try {
      await ensureAgentDirs(workspace);
    } catch (error) {
      await reportStatePathEquality(context, workspace);
      throw error;
    }
    const partition = projectStateDirName(workspace);
    assert.ok(workspaceAgentDir(workspace) === path.join(canonicalState, "workspaces", partition), "runtime path must use the canonical global parent");
    assert.ok(projectSessionsDir(workspace) === path.join(canonicalState, "sessions", partition), "session path must use the canonical global parent");
    assert.deepEqual(await listSessionFiles(workspace), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
