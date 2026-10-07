import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { attachmentFilePath, attachmentRoot, saveAttachment } from "../src/attachments/store.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { resolveSessionFile } from "../src/session/store.js";
import { BINY_BUNDLE_ATTACHMENT_LIMIT, exportSessionBundle, importSessionFile, type BinySessionBundle } from "../src/session/transfer.js";
import { sessionExportCommand } from "../src/cli/commands/sessionTransfer.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-export-attachment-feedback-")));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace };
}

test("CLI bundle export reports a removed saved attachment once and preserves surviving bytes and source history", { timeout: 30_000 }, async (t) => {
  const { root, workspace } = await fixture(t);
  const missing = await saveAttachment(workspace, "missing-report.pdf", "application/pdf", Buffer.from("%PDF-1.7\nmissing"));
  const retainedBytes = Buffer.from("retained report");
  const retained = await saveAttachment(workspace, "retained-report.txt", "text/plain", retainedBytes);
  const recorder = new SessionRecorder(workspace);
  recorder.record({ type: "user_message", content: "Read these reports", attachments: [missing, retained] });
  recorder.record({ type: "user_message", content: "Read the first report again", attachments: [missing] });
  await recorder.close();
  const sourceFile = await resolveSessionFile(workspace, recorder.sessionId);
  const sourceBefore = await fs.readFile(sourceFile);
  const target = path.join(root, "export.json");
  const runExport = async () => {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)),
      "session", "export", recorder.sessionId, "--out", target, "--json"], {
      cwd: workspace, env: { ...process.env }, encoding: "utf8", timeout: 20_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).file, target);
    return JSON.parse(await fs.readFile(target, "utf8")) as BinySessionBundle;
  };
  const complete = await runExport();
  assert.equal(complete.manifest.attachmentCount, 2);
  assert.deepEqual(complete.manifest.skippedAttachments, []);
  await fs.unlink(attachmentFilePath(attachmentRoot(workspace), missing.path)!);
  const incomplete = await runExport();
  assert.equal(incomplete.manifest.attachmentCount, 1);
  assert.equal(incomplete.attachments[0]?.name, retained.name);
  assert.equal(incomplete.attachments[0]?.data, retainedBytes.toString("base64"));
  assert.deepEqual(incomplete.events, complete.events);
  assert.deepEqual(await fs.readFile(sourceFile), sourceBefore);
  assert.deepEqual(await fs.readFile(attachmentFilePath(attachmentRoot(workspace), retained.path)!), retainedBytes);
  assert.deepEqual(incomplete.manifest.skippedAttachments, [missing.name], "a missing saved file must not be reported as an export with no skipped attachments");
});

test("re-export reports a missing imported attachment while preserving its original display name and session", async (t) => {
  const { root, workspace } = await fixture(t);
  const saved = await saveAttachment(workspace, "report..pdf", "application/pdf", Buffer.from("%PDF-1.7\nimported"));
  const recorder = new SessionRecorder(workspace);
  recorder.record({ type: "user_message", content: "Read this report", attachments: [saved] });
  await recorder.close();
  const bundleFile = path.join(root, "source.json");
  await fs.writeFile(bundleFile, (await exportSessionBundle(workspace, recorder.sessionId)).content);
  const targetWorkspace = path.join(root, "imported");
  await fs.mkdir(targetWorkspace);
  const imported = await importSessionFile(targetWorkspace, bundleFile);
  const before = await fs.readFile(imported.filePath);
  const complete = JSON.parse((await exportSessionBundle(targetWorkspace, imported.sessionId)).content) as BinySessionBundle;
  const importedPath = complete.attachments[0]!.sourcePath;
  assert.match(importedPath, /^@attachments\/import-[a-f0-9]{32}\//u);
  await fs.unlink(attachmentFilePath(attachmentRoot(targetWorkspace), importedPath)!);
  const incomplete = JSON.parse((await exportSessionBundle(targetWorkspace, imported.sessionId)).content) as BinySessionBundle;
  assert.deepEqual(incomplete.attachments, []);
  assert.equal(incomplete.manifest.attachmentCount, 0);
  assert.deepEqual(incomplete.manifest.skippedAttachments, ["report..pdf"]);
  assert.deepEqual(incomplete.events, complete.events);
  assert.deepEqual(await fs.readFile(imported.filePath), before);
  assert.equal((await fs.readFile(attachmentFilePath(attachmentRoot(workspace), saved.path)!)).toString(), "%PDF-1.7\nimported");
});

test("export continues to report oversized attachments without embedding them", async (t) => {
  const { workspace } = await fixture(t);
  const saved = await saveAttachment(workspace, "large.pdf", "application/pdf", Buffer.alloc(BINY_BUNDLE_ATTACHMENT_LIMIT + 1));
  const recorder = new SessionRecorder(workspace);
  recorder.record({ type: "user_message", content: "Large report", attachments: [saved] });
  await recorder.close();
  const bundle = JSON.parse((await exportSessionBundle(workspace, recorder.sessionId)).content) as BinySessionBundle;
  assert.deepEqual(bundle.attachments, []);
  assert.equal(bundle.manifest.attachmentCount, 0);
  assert.deepEqual(bundle.manifest.skippedAttachments, [saved.name]);
  assert.equal((await fs.stat(attachmentFilePath(attachmentRoot(workspace), saved.path)!)).size, BINY_BUNDLE_ATTACHMENT_LIMIT + 1);
});

for (const code of ["EACCES", "EIO"]) {
  test(`attachment ${code} errors still abort export without a success message or output file`, async (t) => {
    const { root, workspace } = await fixture(t);
    const bytes = Buffer.from("report bytes");
    const saved = await saveAttachment(workspace, "read-error.txt", "text/plain", bytes);
    const recorder = new SessionRecorder(workspace);
    recorder.record({ type: "user_message", content: "Read this report", attachments: [saved] });
    await recorder.close();
    const source = await resolveSessionFile(workspace, recorder.sessionId);
    const before = await fs.readFile(source);
    const file = attachmentFilePath(attachmentRoot(workspace), saved.path)!;
    const open = fs.open;
    const failure = Object.assign(new Error(`Attachment read failed: ${code}`), { code });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === file) throw failure;
      return await open(...args);
    });
    const output: unknown[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => { output.push(args); });
    const target = path.join(root, "export.json");
    await assert.rejects(sessionExportCommand(workspace, recorder.sessionId, { out: target, json: true }), (error: unknown) => error === failure);
    assert.deepEqual(output, []);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(source), before);
    assert.deepEqual(await fs.readFile(file), bytes);
  });
}
