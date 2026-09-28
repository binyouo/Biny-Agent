/** Runtime Host client 握手必须有界：owner 进程活着但不响应时，connect 要有界失败而不是永久挂起。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion } from "../src/runtime/host/protocol.js";
import type { HostRegistration } from "../src/runtime/host/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-handshake-"));
const servers: net.Server[] = [];
const acceptedSockets = new Set<net.Socket>();
try {
  const paths = runtimeHostPaths(root);
  await mkdir(path.dirname(paths.endpoint), { recursive: true });
  const listenAt = (server: net.Server): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // 修复前 client 永不断开；close 之前必须先掐断已 accept 的连接，否则收尾会跟着挂起。
      server.on("connection", (socket) => {
        acceptedSockets.add(socket);
        socket.once("close", () => acceptedSockets.delete(socket));
      });
      server.listen(paths.endpoint, () => resolve());
    });
  const registration: HostRegistration = {
    protocolVersion: runtimeHostProtocolVersion,
    endpoint: paths.endpoint,
    registrationPath: paths.registrationPath,
    lockPath: paths.lockPath,
    rootHash: paths.rootHash,
    persistenceRoot: root,
    configRoot: "/biny-test/config",
    agentRoot: "/biny-test/agent",
    hostEpoch: randomUUID(),
    token: "test-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  };

  /** 把 connect 的结果压成一句话：挂起（超上限）、成功、或带原因的拒绝。 */
  async function connectOutcome(handshakeTimeoutMs: number): Promise<string> {
    const attempt = RuntimeHostClient.connect({ registration, clientId: "probe", surface: "tui", handshakeTimeoutMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      attempt.then(
        () => "resolved",
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("hung"), 5_000);
      })
    ]);
    clearTimeout(timer);
    return outcome;
  }

  // Given owner 进程的事件循环卡死（socket 可连但 hello 永不应答），When client connect，
  // Then 必须在握手超时内有界失败，而不是让 TUI/Desktop 的启动流程永久停在「runtime 未就绪」。
  const silent = net.createServer(() => {
    // 故意不回应任何帧。
  });
  servers.push(silent);
  await listenAt(silent);
  const silentOutcome = await connectOutcome(300);
  assert.match(silentOutcome, /handshake timed out/iu);

  // Given hello 已应答但 subscribe 永不应答，When client connect，Then 同样必须有界失败。
  await rm(paths.endpoint, { force: true });
  const answersHelloOnly = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let separator = buffer.indexOf("\n");
      while (separator >= 0) {
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        separator = buffer.indexOf("\n");
        let frame: unknown;
        try {
          frame = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (
          frame !== null && typeof frame === "object"
          && (frame as { kind?: string }).kind === "hello"
        ) {
          const requestId = (frame as { requestId?: unknown }).requestId;
          socket.write(`${JSON.stringify({
            kind: "response",
            requestId,
            ok: true,
            result: {
              hostEpoch: registration.hostEpoch,
              persistenceRoot: root,
              sequence: 0,
              protocolVersion: runtimeHostProtocolVersion,
              capabilities: [],
              negotiatedCapabilities: [],
              eventCursor: 0
            }
          })}\n`);
        }
        // subscribe 请求保持沉默。
      }
    });
  });
  servers.push(answersHelloOnly);
  await listenAt(answersHelloOnly);
  const subscribeOutcome = await connectOutcome(300);
  assert.match(subscribeOutcome, /timed out/iu);
  assert.doesNotMatch(subscribeOutcome, /^hung$/u);
} finally {
  for (const socket of acceptedSockets) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
}
console.log("runtime host handshake timeout tests passed");
