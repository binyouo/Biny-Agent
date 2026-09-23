import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authenticateRuntimeHostHello,
  issueRuntimeHostAccessCredential
} from "../src/runtime/host/credentials.js";
import {
  acquireHostLock,
  ensureRuntimeHostDirectory,
  isProcessAlive,
  waitForHostRegistration
} from "../src/runtime/host/lifecycle.js";
import {
  encodeHostFrame,
  negotiateRuntimeHostCapabilities,
  runtimeHostCapabilities,
  runtimeHostProtocolVersion as protocolVersion,
  type HostHelloFrame,
  type HostResponseFrame
} from "../src/runtime/host/protocol.js";
import {
  createRuntimeHostSpawnCircuit,
  RuntimeHostSpawnCircuitOpenError,
  runtimeHostReconnectDelayMs,
  runtimeHostReconnectMaxMs,
  runtimeHostReconnectMinMs,
  runtimeHostReconnectStableMs,
  runtimeHostSpawnCircuitFor,
  runtimeHostSpawnCircuitThreshold
} from "../src/runtime/host/reconnect.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { HostRegistration } from "../src/runtime/host/types.js";

const backoff = { minMs: runtimeHostReconnectMinMs, maxMs: runtimeHostReconnectMaxMs, stableConnectionMs: runtimeHostReconnectStableMs };

// ─── 1. 重连指数退避曲线（250ms 起步、×2、30s 上限）───────────────────────────
// random() = 0.5 时抖动因子恒为 1.0，曲线是纯净的几何级数。
{
  const fixed = { ...backoff, random: () => 0.5 };
  assert.equal(runtimeHostReconnectDelayMs(1, fixed), 250, "第 1 次重连落在基准 250ms");
  assert.equal(runtimeHostReconnectDelayMs(2, fixed), 500, "×2 → 500ms");
  assert.equal(runtimeHostReconnectDelayMs(3, fixed), 1000, "×2 → 1000ms");
  assert.equal(runtimeHostReconnectDelayMs(4, fixed), 2000, "×2 → 2000ms");
  // 250 * 2^30 远超上限，必须被 30s 封顶。
  assert.equal(runtimeHostReconnectDelayMs(30, fixed), runtimeHostReconnectMaxMs, "退避被封顶在 30s");
  assert.equal(runtimeHostReconnectDelayMs(31, fixed), runtimeHostReconnectMaxMs, "封顶后保持 30s，不再翻倍");
}

// 抖动范围：任意 attempt 的延迟都落在 [base*0.8, min(maxMs, base*1.2)]。
{
  const low = runtimeHostReconnectDelayMs(3, { ...backoff, random: () => 0 });
  const high = runtimeHostReconnectDelayMs(3, { ...backoff, random: () => 0.999 });
  assert.equal(low, 800, "抖动下界 = base * 0.8");
  assert.equal(high, 1200, "抖动上界 = base * 1.2");
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const delay = runtimeHostReconnectDelayMs(attempt, backoff);
    assert.ok(delay >= 1 && delay <= runtimeHostReconnectMaxMs, `第 ${String(attempt)} 次延迟 ${String(delay)} 必须落在 [1, 30000]`);
  }
}

// ─── 2. spawn 失败计数熔断（连续 3 次即死 → 终结错误；成功握手重置）─────────────
{
  const circuit = createRuntimeHostSpawnCircuit("/tmp/biny-test.sock");
  assert.equal(circuit.consecutiveFailures, 0);
  assert.equal(circuit.failureError(), undefined, "未达阈值不熔断");
  assert.equal(circuit.recordFailure(), 1);
  assert.equal(circuit.recordFailure(), 2);
  assert.equal(circuit.failureError(), undefined, "2 次仍未达阈值");
  assert.equal(circuit.recordFailure(), 3);
  const error = circuit.failureError();
  assert.ok(error instanceof RuntimeHostSpawnCircuitOpenError, "连续 3 次即死触发熔断");
  assert.match(error.message, /3 times in a row/u);
  assert.match(error.message, /biny daemon uninstall && biny daemon install/u, "熔断错误必须给 actionable 指引");
  // 一次成功握手清零，熔断解除。
  circuit.recordSuccess();
  assert.equal(circuit.consecutiveFailures, 0);
  assert.equal(circuit.failureError(), undefined, "成功握手后熔断复位");
}

// 模块级共享熔断器：同一 endpoint 跨调用方累计，不同 endpoint 相互独立。
{
  const a1 = runtimeHostSpawnCircuitFor("/tmp/biny-shared-a.sock");
  const a2 = runtimeHostSpawnCircuitFor("/tmp/biny-shared-a.sock");
  const b = runtimeHostSpawnCircuitFor("/tmp/biny-shared-b.sock");
  assert.equal(a1, a2, "同一 endpoint 必须共享同一熔断实例");
  a1.recordFailure();
  a1.recordFailure();
  assert.equal(a2.consecutiveFailures, 2, "另一条调用通路可见同一计数");
  assert.equal(b.consecutiveFailures, 0, "不同 workspace 互不影响");
}

// waitForHostRegistration 把「spawn-即死」计入共享熔断：连续 3 次后抛 RuntimeHostSpawnCircuitOpenError。
{
  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-spawn-circuit-test-"));
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < runtimeHostSpawnCircuitThreshold; attempt += 1) {
      // `node -e process.exit(1)` 立即退出，模拟 host 起来即死。
      const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
      try {
        await waitForHostRegistration(persistenceRoot, child);
      } catch (error) {
        lastError = error;
      }
    }
    assert.ok(lastError instanceof RuntimeHostSpawnCircuitOpenError, "第 3 次即死必须抛出熔断终结错误而非普通 attach 错误");
    assert.match((lastError as Error).message, /3 times in a row/u);
  } finally {
    await rm(persistenceRoot, { recursive: true, force: true });
  }
}

// 启动超时也必须回收仍存活的候选进程，不能把 detached Host 留给下一轮重连。
{
  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-spawn-timeout-test-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await assert.rejects(
      waitForHostRegistration(persistenceRoot, child, 40),
      /did not become ready within 40ms/u
    );
    assert.equal(isProcessAlive(child.pid ?? 0), false, "启动超时后候选进程必须被终止");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(persistenceRoot, { recursive: true, force: true });
  }
}

// ─── 3. 协议 v5 骨架 + 握手兼容矩阵（{v3,v5} × {v3,v5}）────────────────────────
assert.equal(protocolVersion, 8, "记忆操作移除版本后缀与 CAS 后使用新协议");

// capabilities 协商：取声明 ∩ 支持，去重，host 不认识的声明不报错只是不生效。
{
  assert.deepEqual(
    negotiateRuntimeHostCapabilities(["runtime.authority", "memory", "runtime.future-op"], runtimeHostCapabilities),
    ["runtime.authority", "memory"],
    "生效集 = client 声明 ∩ host 支持；未知 capability 被丢弃而非报错"
  );
  assert.deepEqual(negotiateRuntimeHostCapabilities([], runtimeHostCapabilities), [], "空声明 → 空生效集");
  assert.deepEqual(
    negotiateRuntimeHostCapabilities(["memory", "memory", "runtime.authority"], runtimeHostCapabilities),
    ["memory", "runtime.authority"],
    "重复声明被去重"
  );
}

function helloFor(version: number): HostHelloFrame {
  return {
    kind: "hello",
    requestId: "hello-1",
    protocolVersion: version,
    rootHash: "root-hash",
    token: "host-token",
    configRoot: "/config",
    agentRoot: "/agent",
    clientId: "client-1",
    surface: "cli",
    capabilities: ["runtime.authority"]
  };
}

function registrationFor(version: number): HostRegistration {
  return {
    protocolVersion: version,
    endpoint: "/tmp/biny-matrix.sock",
    registrationPath: "/tmp/biny-matrix.sock.json",
    lockPath: "/tmp/biny-matrix.sock.lock",
    rootHash: "root-hash",
    persistenceRoot: "/tmp",
    configRoot: "/config",
    agentRoot: "/agent",
    hostEpoch: "epoch-1",
    token: "host-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
}

// host 侧握手判定（authenticateRuntimeHostHello）：版本严格相等才放行。
// v7 host × v5 client → 接受；v7 host × v3 client → 拒绝（无静默降级）。
assert.equal(authenticateRuntimeHostHello(helloFor(5), registrationFor(5), 5), true, "v5↔v5 必须握手成功");
assert.equal(authenticateRuntimeHostHello(helloFor(3), registrationFor(5), 5), false, "v3 client 连 v7 host 必须被拒绝");
// v3 host 侧（其期望版本为 3）：v3 client 接受，v5 client 拒绝。
assert.equal(authenticateRuntimeHostHello(helloFor(3), registrationFor(3), 3), true, "v3↔v3 必须握手成功");
assert.equal(authenticateRuntimeHostHello(helloFor(5), registrationFor(3), 3), false, "v5 client 连 v3 host 必须被拒绝");

// ─── 4. 端到端握手：v7 host 上跑的 server 必须把「拒绝原因」作为响应帧透给 client ────
// §4.2 硬要求：被拒绝的组合要给 actionable 错误，不允许静默降级为 connection closed。
// 老 client（protocolVersion=3）撞上 v7 host 时，必须读到带 daemon 重装指引的拒绝帧。
{
  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-handshake-reject-test-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-handshake-reject-ws-"));
  const token = issueRuntimeHostAccessCredential().secret;
  const { runtimeHostPaths } = await import("../src/runtime/host/lifecycle.js");
  const paths = runtimeHostPaths(persistenceRoot);
  const registration: HostRegistration = {
    protocolVersion, // v7 host
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot,
    configRoot: "/config",
    agentRoot: "/agent",
    hostEpoch: "epoch-handshake",
    token,
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  const stubSnapshot = {
    revision: 0,
    info: { sessionId: "s", sessionFile: "/tmp/s.jsonl", workspaceRoot, provider: "t", modelAlias: "m", modelLabel: "M", reasoningLabel: "Off", thinking: "off", skills: [] },
    permissionMode: "ask",
    state: { kind: "idle" }
  } as unknown as InteractiveRuntimeSnapshot;
  const stubRuntime = {
    getSnapshot: () => stubSnapshot,
    subscribe: () => () => undefined,
    releaseSessionClaim: async () => undefined,
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const lock = await acquireHostLock(paths, persistenceRoot);
  const server = new RuntimeHostServer(stubRuntime, {} as unknown as CommandRuntime, registration, lock);
  let rejection: { error?: string; errorCode?: string } | undefined;
  try {
    await server.listen();
    const hello: HostHelloFrame = {
      kind: "hello",
      requestId: "hello-reject",
      protocolVersion: 3, // v3 client 撞上 v7 host
      rootHash: paths.rootHash,
      token, // 凭据正确，纯粹是版本不匹配
      configRoot: "/config",
      agentRoot: "/agent",
      clientId: "old-client",
      surface: "cli",
      capabilities: ["runtime.authority"]
    };
    rejection = await new Promise((resolve, rejectPromise) => {
      const socket = net.createConnection(paths.endpoint);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("connect", () => socket.write(encodeHostFrame(hello)));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline)) as HostResponseFrame;
        socket.destroy();
        resolve({ error: frame.error, errorCode: frame.errorCode });
      });
      socket.once("error", rejectPromise);
      setTimeout(() => rejectPromise(new Error("host did not answer the rejected hello in time")), 5_000);
    });
  } finally {
    await server.close().catch(() => undefined);
    await rm(persistenceRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  assert.equal(rejection?.errorCode, "protocol_version_mismatch", "拒绝帧必须带 protocol_version_mismatch 错误码");
  assert.match(rejection?.error ?? "", /protocol 8 is incompatible with 3/u, "拒绝消息先报告 Host 版本，再报告客户端版本");
  assert.match(rejection?.error ?? "", /PID \d+/u, "拒绝消息必须指出实际 owner，不建议不存在的 daemon 命令");
}

console.log("runtime-host-reconnect tests passed");
