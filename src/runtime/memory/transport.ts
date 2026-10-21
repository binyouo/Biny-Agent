import { createServer, request, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import { secureLocalIpcEndpoint } from "../../utils/localIpc.js";
import {
  acquireHostLock, ensureRuntimeHostDirectory, isProcessAlive, readRegistration, removeRegistration,
  removeSocketIfStale, runtimeHostLaunchPlan, runtimeHostPaths, terminateSpawnedHost, writeRegistration
} from "../host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../host/protocol.js";
import type { HostRegistration } from "../host/types.js";
import type { AgentMemoryOwner } from "./owner.js";

const maximumBodyBytes = 16 * 1024 * 1024;

export async function canonicalMemoryRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

export function memoryOwnerPaths(root: string) {
  return runtimeHostPaths(path.join(root, ".memory-owner"));
}

export async function serveMemoryOwner(root: string, configRoot: string, owner: AgentMemoryOwner): Promise<{ close(): Promise<void> }> {
  const paths = memoryOwnerPaths(root);
  const lock = await (async () => {
    await ensureRuntimeHostDirectory(path.dirname(paths.registrationPath));
    return acquireHostLock(paths, path.join(root, ".memory-owner"));
  })().catch(async error => {
    await owner.close();
    throw error;
  });
  const registration: HostRegistration = {
    ...paths, persistenceRoot: path.join(root, ".memory-owner"), agentRoot: root, configRoot,
    protocolVersion: runtimeHostProtocolVersion, hostEpoch: randomUUID(), token: randomUUID(),
    pid: process.pid, createdAt: new Date().toISOString()
  };
  let closing = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (closing) throw new Error("Memory owner is closing.");
      if (req.headers.authorization !== `Bearer ${registration.token}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/memory") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(req)) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid memory request.");
      const input = body as Record<string, unknown>;
      if (typeof input.action !== "string" || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
        throw new Error("Invalid memory request.");
      }
      const controller = new AbortController();
      // 维护任务归 owner；客户端退出只取消本次检索/推理，不取消全局维护。
      const maintenance = ["sleep.run", "embedding.rebuild", "embedding.download", "embedding.remove", "maintain"].includes(input.action);
      const disconnect = () => { if (!res.writableEnded && !maintenance) controller.abort(); };
      res.once("close", disconnect);
      try {
        const result = await owner.execute(input.action, input.payload as Record<string, unknown>, controller.signal);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: result ?? null }));
      } finally { res.off("close", disconnect); }
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  server.requestTimeout = 30_000;
  try {
    await removeSocketIfStale(paths.endpoint);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, resolve); });
    await secureLocalIpcEndpoint(paths.endpoint);
    await writeRegistration(registration);
  } catch (error) {
    server.closeAllConnections();
    await Promise.allSettled([closeServer(server), owner.close(), lock.close()]);
    throw error;
  }
  let closingPromise: Promise<void> | undefined;
  return {
    close() {
      closingPromise ??= (async () => {
        closing = true;
        const closed = closeServer(server);
        // 收回模型任务后关闭残余连接；任一清理失败不阻止其余资源释放。
        const ownerResult = await Promise.allSettled([owner.close()]);
        server.closeAllConnections();
        const results = [...ownerResult, ...await Promise.allSettled([closed, removeRegistration(registration), lock.close()])];
        const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, "Memory owner cleanup failed.");
      })();
      return closingPromise;
    }
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBodyBytes) throw new Error("Memory request exceeds the message limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function memoryRequest<T>(registration: HostRegistration, action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = request({ socketPath: registration.endpoint, method: "POST", path: "/memory", signal,
      headers: { authorization: `Bearer ${registration.token}`, "content-type": "application/json" }
    }, res => {
      void readBody(res).then(body => {
        const result = JSON.parse(body) as { result: T; error?: string };
        if (res.statusCode !== 200) throw new Error(result.error ?? `Memory owner returned HTTP ${res.statusCode}.`);
        resolve(result.result);
      }).catch(reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ action, payload }));
  });
}

const starting = new Map<string, Promise<HostRegistration>>();

export async function discoverMemoryOwner(root = globalAgentDir(), configRoot = globalConfigDir(), start = true): Promise<HostRegistration | undefined> {
  const canonical = start ? await canonicalMemoryRoot(root) : await realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (canonical === undefined) return undefined;
  const paths = memoryOwnerPaths(canonical);
  const current = await readRegistration(paths);
  if (current && isProcessAlive(current.pid)) {
    if (current.protocolVersion !== runtimeHostProtocolVersion || current.agentRoot !== canonical
      || path.resolve(current.configRoot ?? "") !== path.resolve(configRoot)) {
      throw new Error("Memory owner has a different protocol or configuration root; stop that owner before changing environments.");
    }
    return current;
  }
  if (!start) return undefined;
  let pending = starting.get(canonical);
  if (!pending) {
    pending = spawnMemoryOwner(canonical, configRoot);
    starting.set(canonical, pending);
    void pending.finally(() => { if (starting.get(canonical) === pending) starting.delete(canonical); }).catch(() => undefined);
  }
  return pending;
}

async function spawnMemoryOwner(root: string, configRoot: string): Promise<HostRegistration> {
  const currentFile = fileURLToPath(import.meta.url);
  const entryPath = path.join(path.dirname(currentFile), `../memoryProcess${currentFile.endsWith(".ts") ? ".ts" : ".js"}`);
  const plan = runtimeHostLaunchPlan(path.join(root, ".memory-owner"), {
    workspaceRoot: root, configDir: configRoot, entryPath, lifecycleMode: "service"
  });
  const args = plan.args.map(arg => arg === "--biny-runtime-host" ? "--biny-memory-owner" : arg);
  const child = spawn(plan.executable, args, { env: { ...plan.env, BINY_AGENT_DIR: root }, detached: true, stdio: "ignore", windowsHide: true });
  let failure: Error | undefined;
  child.once("error", error => { failure = error; });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const registered = await readRegistration(memoryOwnerPaths(root));
    // 多客户端同时启动时，败选候选退出，所有客户端接入胜出的同一 owner。
    if (registered && isProcessAlive(registered.pid)) return registered;
    if (failure) throw failure;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  if (child.exitCode === null) await terminateSpawnedHost(child);
  throw new Error("Memory owner did not become ready.");
}
