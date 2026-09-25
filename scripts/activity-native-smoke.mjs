/** 无窗口验收：真实 nativeImage 压缩、Unix socket daemon、独立 OCR 与输入进程。 */
import { app, nativeImage } from "electron";
import { register } from "tsx/esm/api";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
register();
const { ActivityStore } = await import("../src/activity/store.ts");
const { encodeActivityFrame, recompressActivitySnapshot } = await import("../src/desktop/electron/main/activityCapture.ts");
const children = [];
const exited = [];
function child(name, args, stdio) {
  const process = spawn(path.resolve("out/native", name), args, {stdio});
  children.push(process);
  exited.push(new Promise(resolve => { process.once("exit", resolve); process.once("error", resolve); }));
  return process;
}
app.whenReady().then(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-native-smoke-"));
  const store = new ActivityStore();
  try {
    const bitmap = Buffer.alloc(2000 * 1000 * 4, 255);
    const jpeg = nativeImage.createFromBitmap(bitmap, {width:2000, height:1000}).toJPEG(90);
    const encoded = await encodeActivityFrame(jpeg, 55);
    assert.deepEqual(encoded.jpeg,jpeg,"原生 JPEG 不二次编码");
    assert.equal(encoded.width, 2000);
    assert.equal(encoded.pixels.length, 160 * 90 * 4);
    await store.open(root, root);
    const started = new Date(Date.now() - 2 * 86400000).toISOString();
    const id = store.startSession(started);
    const capture = await store.recordFallbackCapture({sessionId:id, occurredAt:started, eventType:"heartbeat", jpeg});
    await store.rotateSnapshots(10240, new Date(), recompressActivitySnapshot);
    const snapshot = store.getSessionDetail(id).snapshots[0];
    assert.equal(snapshot.storageTier, "warm");
    assert.equal(snapshot.width, 1280);
    assert.equal(snapshot.height, 640);
    const imagePath = store.getSnapshotPath(capture.snapshotId);
    await promisify(execFile)(path.resolve("out/native/activity-ocr"), [imagePath, "en-US"], {timeout:30000});
    const socketPath = path.join(root, "capture.sock");
    const daemon = child("computer-use", ["daemon", "--socket", socketPath], ["ignore", "pipe", "pipe"]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon readiness timeout")), 10000);
      daemon.once("error", reject);
      daemon.stdout.once("data", () => {clearTimeout(timer); resolve();});
    });
    await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => socket.destroy(new Error("socket timeout")), 5000);
      socket.once("connect", () => socket.write(JSON.stringify({id:"smoke",cmd:"ping"}) + "\n"));
      socket.once("data", data => { assert.equal(JSON.parse(data.toString()).data.ok, true); clearTimeout(timer); socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    const input = child("activity-input-monitor", [], ["pipe", "pipe", "pipe"]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("input status timeout")), 10000);
      const lines = createInterface({input: input.stdout});
      input.once("error", reject);
      lines.on("line", line => {
        const value = JSON.parse(line);
        if (value.type !== "status") return;
        assert.equal(typeof value.screenRecordingGranted, "boolean");
        clearTimeout(timer); lines.close(); resolve();
      });
      input.stdin.write(JSON.stringify({type:"start",settings:{inputMonitoringEnabled:false}}) + "\n");
    });
    console.log("PASS: nativeImage encode/rotation, socket daemon ping, OCR process, input status");
  } finally {
    children.forEach(process => process.kill("SIGTERM"));
    await Promise.all(exited);
    await store.close();
    await rm(root, {recursive:true, force:true});
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
