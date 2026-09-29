import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BoundedHostSocketWriter } from "../src/runtime/host/socket-writer.js";
import { runtimeHostMaxFrameBytes, type HostFrame } from "../src/runtime/host/protocol.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writes: string[] = [];
  nextWriteBackpressured = false;

  write(data: string): boolean {
    this.writes.push(data);
    const bytes = Buffer.byteLength(data);
    if (this.nextWriteBackpressured) {
      this.nextWriteBackpressured = false;
      this.writableLength += bytes;
      return false;
    }
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

const frame = (payload: string): HostFrame => ({
  kind: "request",
  requestId: "test",
  operation: payload,
  payload: {}
});

{
  const socket = new FakeSocket();
  const writer = new BoundedHostSocketWriter(socket, 1_024);
  socket.nextWriteBackpressured = true;
  assert.equal(writer.send(frame("first")), true);
  assert.equal(writer.send(frame("second")), true);
  assert.equal(socket.writes.length, 1, "writes queue behind a socket reporting backpressure");
  socket.writableLength = 0;
  socket.emit("drain");
  assert.equal(socket.writes.length, 2, "queued frame flushes after drain");
  writer.dispose();
}

{
  const socket = new FakeSocket();
  const writer = new BoundedHostSocketWriter(socket, 140);
  socket.nextWriteBackpressured = true;
  assert.equal(writer.send(frame("first")), true);
  assert.equal(writer.send(frame("second")), false, "overflow must reject more buffered bytes");
  assert.equal(socket.destroyed, true, "a slow peer is disconnected instead of buffering without limit");
  assert.equal(socket.writes.length, 1, "overflowing frame is never written");
}

{
  const socket = new FakeSocket();
  const writer = new BoundedHostSocketWriter(socket, runtimeHostMaxFrameBytes * 2);
  assert.equal(writer.send(frame("x".repeat(runtimeHostMaxFrameBytes))), false, "outbound frames must obey the protocol's per-frame limit");
  assert.equal(socket.destroyed, true);
}

console.log("runtime host transport tests passed");
