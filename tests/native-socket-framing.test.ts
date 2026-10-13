import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

test("real native-driver socket preserves large fragmented Unicode frames and coalesced events", { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-r-"));
  const binary = "inert-fixture-binary";
  const binaryPath = path.join(root, "never-executed");
  await writeFile(binaryPath, binary);
  const socketPath = path.join(root, `biny-computer-use-${createHash("sha1").update(binary).digest("hex").slice(0, 8)}.sock`);
  const sockets = new Set<net.Socket>();
  const data = { apps: [{ title: "中文🙂".repeat(80000) }] };
  const server = net.createServer(socket => {
    sockets.add(socket);
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk.toString();
      if (!pending.includes("\n")) return;
      const request = JSON.parse(pending.slice(0, pending.indexOf("\n")));
      pending = "";
      assert.equal(request.cmd, "list_apps");
      const frame = Buffer.from(`${JSON.stringify({ event: "fixture", data: 1 })}\n${JSON.stringify({ id: request.id, ok: true, data })}\n`);
      let offset = 0;
      const send = () => {
        if (socket.destroyed) return;
        socket.write(frame.subarray(offset, offset + 16381));
        offset += 16381;
        if (offset < frame.length) setImmediate(send);
      };
      send();
    });
  });
  const driver = new NativeProcessDriver(() => undefined, { binaryPath, socketDir: root });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    const events: unknown[] = [];
    driver.onNativeEvent((name, value) => events.push([name, value]));
    const reply = await driver.list("fixture", undefined);
    assert.deepEqual(reply.data, data);
    assert.deepEqual(reply.images, []);
    assert.deepEqual(events, [["fixture", 1]]);
  } finally {
    driver.detach();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
