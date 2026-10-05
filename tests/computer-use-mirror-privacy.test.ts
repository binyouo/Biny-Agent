import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureSchedule, CaptureBusyError } from "../src/computer/captureSchedule.js";
import { readNativeMirrorPrivacy } from "../src/computer/nativeMirrorPrivacy.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Activity cannot capture a native mirror or retain a frame spanning its presentation", async () => {
  let privacy = { active: true, epoch: "open" };
  const captures = new CaptureSchedule(Date.now, async () => privacy);
  await assert.rejects(captures.run("activity", async () => "private pixels"), CaptureBusyError);
  privacy = { active: false, epoch: "closed" };
  await assert.rejects(captures.run("activity", async () => {
    privacy = { active: false, epoch: "opened-and-closed" };
    return "private pixels";
  }), CaptureBusyError);
  assert.equal(await captures.run("activity", async () => "ordinary pixels"), "ordinary pixels");
});

test("native privacy metadata is checked without starting or capturing a desktop process", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-privacy-registry-"));
  const file = path.join(directory, `${process.pid}.json`);
  try {
    await writeFile(file, JSON.stringify({ pid: process.pid, active: true, epoch: "first" }), { mode: 0o600 });
    const shown = await readNativeMirrorPrivacy(directory);
    assert.equal(shown.active, true);
    await writeFile(file, JSON.stringify({ pid: process.pid, active: false, epoch: "second" }));
    const closed = await readNativeMirrorPrivacy(directory);
    assert.equal(closed.active, false); assert.notEqual(closed.epoch, shown.epoch);
    await writeFile(file, "invalid");
    assert.equal((await readNativeMirrorPrivacy(directory)).active, true, "unreadable state must stop passive capture");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
