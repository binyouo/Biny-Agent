import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentFilePath, attachmentRoot, readAttachment, readAttachmentContext, saveAttachment, savePendingAttachmentContext, updatePendingAttachmentContext } from "../src/attachments/store.js";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-appshot-context-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "agent");
  const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace);
  const attachment = await saveAttachment(workspace, "capture.jpg", "image/jpeg", Buffer.from("pixels"));
  const root = attachmentRoot(workspace), file = attachmentFilePath(root, attachment.path)!;
  const pending = path.join(path.dirname(file), `.appshot-${createHash("sha256").update(attachment.path).digest("hex")}.pending`);
  t.after(async () => { if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, workspace, root, attachment, file, pending };
}

test("Appshot context can update until first model read, then remains fixed for replay", async t => {
  const f = await fixture(t);
  await savePendingAttachmentContext(f.root, f.attachment.path, "initial pending context");
  assert.equal(await updatePendingAttachmentContext(f.root, f.attachment.path, "completed context"), true);
  assert.equal((await readAttachment(f.workspace, f.attachment))?.hiddenContext, "completed context");
  assert.equal(await updatePendingAttachmentContext(f.root, f.attachment.path, "late context"), false);
  assert.equal((await readAttachment(f.workspace, f.attachment))?.hiddenContext, "completed context");
  assert.equal((await fs.stat(`${f.file}.context`)).mode & 0o077, 0);
  await assert.rejects(fs.lstat(f.pending), { code: "ENOENT" });
});

test("concurrent first use and late context commit agree on one immutable result", async t => {
  const f = await fixture(t);
  await savePendingAttachmentContext(f.root, f.attachment.path, "before");
  const [changed, first] = await Promise.all([
    updatePendingAttachmentContext(f.root, f.attachment.path, "after"),
    readAttachment(f.workspace, f.attachment)
  ]);
  assert.equal(first?.hiddenContext, changed ? "after" : "before");
  assert.equal((await readAttachment(f.workspace, f.attachment))?.hiddenContext, first?.hiddenContext);
  assert.equal(await updatePendingAttachmentContext(f.root, f.attachment.path, "later"), false);
});

test("sealing and a late update in different processes agree on the context", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await savePendingAttachmentContext(f.root, f.attachment.path, "before");
  const code = `import { updatePendingAttachmentContext } from './src/attachments/store.ts';
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => {
      try { process.stdout.write(String(await updatePendingAttachmentContext(process.argv[1], process.argv[2], 'after')) + '\\n'); }
      catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
    });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, f.root, f.attachment.path], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  while (!output.includes("ready\n")) {
    if (child.exitCode !== null) throw new Error(`child exited: ${errors}`);
    await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error(`child exited: ${errors}`); })]);
  }
  child.stdin.end("go");
  const first = await readAttachment(f.workspace, f.attachment);
  const [codeResult] = await exited;
  assert.equal(codeResult, 0, errors);
  const changed = output.includes("true\n");
  assert.match(output, /(?:true|false)\n/u);
  assert.equal(first?.hiddenContext, changed ? "after" : "before");
  assert.equal((await readAttachment(f.workspace, f.attachment))?.hiddenContext, first?.hiddenContext);
});

test("sealing recovers a crash between linking the final context and removing its pending name", async t => {
  const f = await fixture(t);
  await savePendingAttachmentContext(f.root, f.attachment.path, "recoverable");
  await fs.link(f.pending, `${f.file}.context`);
  assert.equal((await fs.stat(f.pending)).nlink, 2);
  assert.equal(await readAttachmentContext(f.root, f.attachment.path), "recoverable");
  assert.equal((await fs.stat(`${f.file}.context`)).nlink, 1);
  await assert.rejects(fs.lstat(f.pending), { code: "ENOENT" });
});

test("a crash while publishing the pending context can be recovered before update or use", async t => {
  const f = await fixture(t);
  await savePendingAttachmentContext(f.root, f.attachment.path, "before");
  await fs.link(f.pending, `${f.pending}.writing`);
  assert.equal(await updatePendingAttachmentContext(f.root, f.attachment.path, "after"), true);
  assert.equal(await readAttachmentContext(f.root, f.attachment.path), "after");
  await assert.rejects(fs.lstat(`${f.pending}.writing`), { code: "ENOENT" });
});

test("pending Appshot context rejects symlinks and missing attachments", async t => {
  const f = await fixture(t), outside = path.join(f.directory, "outside");
  await fs.writeFile(outside, "untouched");
  await savePendingAttachmentContext(f.root, f.attachment.path, "initial");
  await fs.unlink(f.pending); await fs.symlink(outside, f.pending);
  await assert.rejects(updatePendingAttachmentContext(f.root, f.attachment.path, "replacement"), /attachment_path_invalid/);
  await assert.rejects(readAttachmentContext(f.root, f.attachment.path), /attachment_path_invalid/);
  assert.equal(await fs.readFile(outside, "utf8"), "untouched");
  await fs.unlink(f.pending); await fs.unlink(f.file);
  assert.equal(await updatePendingAttachmentContext(f.root, f.attachment.path, "replacement"), false);
});
