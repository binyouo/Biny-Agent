import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AcpClient } from "../src/acp/client.js";
import { acpConfigSchema } from "../src/acp/config.js";

const execFileAsync = promisify(execFile);
type Peer = { pid: number; socket: Socket; closed: Promise<void> };
type Outcome = { kind: "fulfilled" } | { kind: "rejected"; error: unknown };

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`ACP group fixture stalled: ${label}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function processState(pid: number): Promise<{ group: number; state: string } | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], { timeout: 1_000 });
    const fields = stdout.trim().split(/\s+/u);
    if (!fields[0]) return undefined;
    assert.equal(fields.length, 2, "ps must return one process identity/state row");
    return { group: Number(fields[0]), state: fields[1]! };
  } catch (error) {
    // ps exits 1 when the selected PID no longer exists. Other failures are fixture failures.
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}

async function assertStopped(peer: Peer, context: string): Promise<void> {
  try { await bounded(peer.closed, "owned child control connection did not close"); }
  catch (error) {
    const state = await processState(peer.pid);
    if (state && !state.state.startsWith("Z")) {
      assert.fail(`${context}: owned child ${peer.pid} remains alive in group ${state.group} (${state.state})`);
    }
    throw new Error(`${context}: control socket did not close despite stopped child; fixture observation failed`, { cause: error });
  }
  // EOF alone is not the oracle. A reaped process or a non-executing zombie is stopped.
  // A reused, live PID fails conservatively; no signal is ever sent to this number.
  const deadline = Date.now() + 2_000;
  while (true) {
    const state = await processState(peer.pid);
    if (!state || state.state.startsWith("Z")) return;
    assert.ok(Date.now() < deadline, `${context}: owned child ${peer.pid} remained running (${state.state})`);
    await delay(10);
  }
}

for (const scenario of [
  { phase: "initialize", exitKind: "code", activeClose: false },
  { phase: "prompt", exitKind: "signal", activeClose: false },
  { phase: "prompt", exitKind: "code", activeClose: true }
] as const) {
  test(`ACP reclaims its group after ${scenario.activeClose ? "active close" : `${scenario.phase} ${scenario.exitKind} exit`}`, {
    skip: process.platform === "win32", timeout: 20_000
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-group-"));
    const endpoint = path.join(root, "control.sock");
    const token = randomUUID();
    const leaderReady = Promise.withResolvers<Peer>();
    const childReady = Promise.withResolvers<Peer>();
    const fault = Promise.withResolvers<never>();
    void fault.promise.catch(() => undefined);
    const sockets = new Set<Socket>();
    const peers: Peer[] = [];
    const closures: Promise<void>[] = [];
    const roles = new Set<string>();
    let cleaning = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      closures.push(closed);
      socket.on("error", (error) => { if (!cleaning) fault.reject(error); });
      // Cleanup is independent of the implementation and also covers late arrivals.
      if (cleaning) { socket.end("cleanup\n"); return; }
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        socket.removeAllListeners("data");
        try {
          const hello = JSON.parse(buffer.slice(0, newline)) as { token?: string; role?: string; pid?: number };
          assert.equal(hello.token, token);
          assert.ok(hello.role === "leader" || hello.role === "child");
          assert.ok(Number.isSafeInteger(hello.pid) && hello.pid! > 0);
          assert.ok(!roles.has(hello.role), "fixture role must connect exactly once");
          roles.add(hello.role);
          const peer = { pid: hello.pid!, socket, closed };
          peers.push(peer);
          if (hello.role === "leader") leaderReady.resolve(peer);
          else childReady.resolve(peer);
        } catch (error) { fault.reject(error); socket.end("cleanup\n"); }
      });
    });
    server.on("error", (error) => fault.reject(error));
    const client = new AcpClient({ cwd: root, launch: acpConfigSchema.parse({ command: process.execPath,
      args: [path.resolve("tests/fixtures/acp-exit-group-agent.mjs"), "leader", endpoint, token, scenario.phase, scenario.exitKind] }) });
    let running: Promise<Outcome> | undefined;
    try {
      await bounded(Promise.race([new Promise<void>((resolve) => server.listen(endpoint, resolve)), fault.promise]), "control listener");
      const operation = scenario.phase === "initialize" ? client.connect() : client.prompt({
        content: [{ type: "text", text: "fixture" }], model: "default", onUpdate() {},
        onPermission: async () => ({ outcome: { outcome: "cancelled" } })
      });
      running = operation.then((): Outcome => ({ kind: "fulfilled" }), (error: unknown): Outcome => ({ kind: "rejected", error }));
      const [leader, child] = await bounded(Promise.race([
        Promise.all([leaderReady.promise, childReady.promise]), fault.promise
      ]), "leader and child readiness");
      const [leaderState, childState] = await Promise.all([processState(leader.pid), processState(child.pid)]);
      assert.equal(leaderState?.group, leader.pid, "adapter owns a fresh POSIX process group");
      assert.equal(childState?.group, leader.pid, "child must inherit the adapter group");
      assert.ok(childState && !childState.state.startsWith("Z"), "child must be live before the exit gate");
      if (scenario.activeClose) await bounded(client.close(), "active close");
      else leader.socket.write("exit\n");
      const outcome = await bounded(Promise.race([running, fault.promise]), "request settles after leader exit");
      assert.equal(outcome.kind, "rejected");
      if (!scenario.activeClose && outcome.kind === "rejected") {
        assert.match(String(outcome.error), scenario.exitKind === "code" ? /ACP 进程已退出 \(7\)/u : /ACP 进程已退出 \(SIGTERM\)/u);
      }
      await assertStopped(child, "ACP group cleanup after confirmed adapter exit");
      await client.close();
      await client.close();
    } finally {
      cleaning = true;
      // These are already-established fixture identities, never a stale-PID kill.
      for (const socket of sockets) if (!socket.destroyed) socket.end("cleanup\n");
      try {
        await bounded(client.close(), "final client cleanup");
        if (running) await bounded(running, "final request join");
      } finally {
        try {
          // New child connections now fail and the fixture exits on socket error.
          await bounded(new Promise<void>((resolve, reject) => server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          })), "control server cleanup");
          await bounded(Promise.all(closures), "fixture socket cleanup");
          for (const peer of peers) await assertStopped(peer, "Independent fixture cleanup");
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  });
}
