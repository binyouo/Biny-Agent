import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentFilePath, attachmentRoot, readAttachment, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";

type RootMode = "default" | "explicit" | "custom";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const context = JSON.stringify({source:{appName:"Browser",bundleId:"synthetic.browser",pid:123,windowId:456,title:"Invoice"},accessibility:"URL: https://invoice.invalid/42\nSelected text: Invoice balance is 731 dollars"});
const expected = [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }];

async function fixture(t: TestContext, mode: RootMode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-attachment-retry-root-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let local: Awaited<ReturnType<typeof createInteractiveAgentHost>> | undefined = undefined;
  t.after(async () => {
    await local?.runtime.close();
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://attachment-fixture.invalid/v1/chat/completions");
    const body = await request.json();
    requests.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Attachment received" }, finish_reason: "stop" }] });
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Attachment received" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  await configStore.save(configSchema.parse({
    ...structuredClone(defaultConfig),
    defaultModel: "attachment-fixture",
    providers: { fixture: { type: "openai-compatible", baseUrl: "https://attachment-fixture.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "attachment-fixture": { provider: "fixture", model: "attachment-fixture", capabilities: { vision: true, tools: true, streaming: true } } },
    chat: { ...defaultConfig.chat, defaultToolSelection: "none", defaultSkillSelection: "none" },
    activity: { ...defaultConfig.activity, enabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  const reference = await saveAttachment(root, "picture.png", "image/png", png);
  await saveAttachmentContext(attachmentRoot(root), reference.path, context);
  const native = await readAttachment(root, reference);
  assert.ok(native);
  const directory = mode === "custom" ? path.join(root, "custom-attachments") : attachmentRoot(root);
  if (mode === "custom") await rename(attachmentRoot(root), directory);
  const open = async (workspace = root) => {
    local = await createInteractiveAgentHost(workspace, { configStore, attachmentRoot: mode === "default" ? undefined : directory });
    return local.runtime;
  };
  const runtime = await open();
  if (mode === "custom") {
    // A same-named file in the default partition must never override the configured directory.
    await writeFile(attachmentFilePath(attachmentRoot(root), reference.path)!, "wrong-default-partition");
  }
  const images = (start = 0) => requests.slice(start).flatMap(request => request.messages)
    .filter(message => message.role === "user")
    .flatMap(message => Array.isArray(message.content) ? message.content as Array<{ type: string }> : [])
    .filter(part => part.type === "image_url");
  const first = runtime.submitPrompt("Inspect this picture", [native]);
  assert.equal((await first.completion).status, "completed");
  assert.deepEqual(images(), expected, "initial provider input must include the original image");
  const info = runtime.getSnapshot().info;
  const events = await readSessionEvents(info.sessionFile);
  assert.deepEqual(events.find(event => event.type === "user_message")?.attachments, [reference]);
  const persisted = await readFile(info.sessionFile, "utf8");
  assert.ok(!persisted.includes(context));
  assert.ok(!persisted.includes(png.toString("base64")));
  return { runtime, open, requests, images, first, info, directory, reference, native, root };
}



import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createSessionFile, ensureAgentDirs, listSessionFiles } from "../src/session/store.js";
import { refreshSessionIndex } from "../src/session/catalog.js";
import { readSealedAttachmentContextBytes, savePendingAttachmentContext, updatePendingAttachmentContext, attachmentFilePath } from "../src/attachments/store.js";
import { exportSessionBundle, importSessionFile } from "../src/session/transfer.js";

test("real Runtime bundle import preserves Appshot context on continuation and retry", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "default");
  const exported = await exportSessionBundle(f.root, f.info.sessionId);
  const bundle = JSON.parse(exported.content);
  assert.equal(bundle.version, 3);
  assert.deepEqual(bundle.manifest.skippedAttachments, []);
  assert.equal(Buffer.from(bundle.attachments[0].context.data, "base64").toString("utf8"), context);
  const source = path.join(f.root, "bundle.json");
  await writeFile(source, exported.content);
  const destination = path.join(f.root, "destination");
  await fs.mkdir(destination);
  await ensureAgentDirs(destination);
  const originalLog = await readFile(f.info.sessionFile, "utf8");
  const imported = await importSessionFile(destination, source);
  assert.equal(imported.attachmentsRestored, 1);
  assert.equal(imported.attachmentsSkipped, 0);
  await f.runtime.close();
  const runtime = await f.open(destination);
  await runtime.resumeSession(imported.sessionId);
  let start = f.requests.length;
  assert.equal((await runtime.submitPrompt("What balance was selected?").completion).status, "completed");
  assert.deepEqual(f.images(start), expected);
  assert.ok(JSON.stringify(f.requests.slice(start)).includes("731 dollars"));
  assert.ok(JSON.stringify(f.requests.slice(start)).includes("invoice.invalid"));
  const events = await readSessionEvents(imported.filePath);
  const first = events.find(e => e.type === "user_message");
  assert.ok(first?.messageId);
  start = f.requests.length;
  assert.equal((await runtime.submitPrompt("Inspect this picture", [], { retryOfMessageId: first.messageId }).completion).status, "completed");
  assert.deepEqual(f.images(start), expected);
  assert.ok(JSON.stringify(f.requests.slice(start)).includes("731 dollars"));
  const persisted = await readFile(imported.filePath, "utf8");
  assert.ok(!persisted.includes("731 dollars"));
  const again = JSON.parse((await exportSessionBundle(destination, imported.sessionId)).content);
  assert.deepEqual(again.attachments[0].context, bundle.attachments[0].context);
  assert.equal(await readFile(f.info.sessionFile, "utf8"), originalLog);
});

async function filesFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-context-bundle-"));
  const before = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await ensureAgentDirs(workspace);
  t.after(async () => {
    t.mock.restoreAll();
    await refreshSessionIndex(workspace);
    if (before === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = before;
    await rm(root, { recursive: true, force: true });
  });
  const reference = await saveAttachment(workspace, "screen.png", "image/png", png);
  await createSessionFile(workspace, "source", Buffer.from(JSON.stringify({ type: "user_message", content: "inspect", attachments: [reference] }) + "\n"));
  const source = path.join(root, "bundle.json");
  const directory = attachmentRoot(workspace);
  const exportToFile = async () => {
    const exported = await exportSessionBundle(workspace, "source");
    await writeFile(source, exported.content);
    return JSON.parse(exported.content);
  };
  return { root, workspace, source, directory, reference, exportToFile };
}

test("legacy v2 ordinary attachment imports without context and does not consult another workspace", async t => {
  const f = await filesFixture(t);
  const bundle = await f.exportToFile();
  assert.equal(bundle.version, 2);
  bundle.version = 2;
  assert.equal(bundle.attachments[0].context, undefined);
  await writeFile(f.source, JSON.stringify(bundle));
  const destination = path.join(f.root, "other");
  await fs.mkdir(destination);
  await ensureAgentDirs(destination);
  const imported = await importSessionFile(destination, f.source);
  const event = (await readSessionEvents(imported.filePath)).find(e => e.type === "user_message");
  assert.ok(event?.attachments?.[0]);
  const hydrated = await readAttachment(destination, event.attachments[0]);
  assert.equal(hydrated?.data, png.toString("base64"));
  assert.equal(hydrated?.hiddenContext, undefined);
  await refreshSessionIndex(destination);
});

test("pending-only context refuses export without sealing or changing pending capture", async t => {
  const f = await filesFixture(t);
  await savePendingAttachmentContext(f.directory, f.reference.path, "pending");
  const before = await fs.readdir(f.directory);
  await assert.rejects(f.exportToFile(), /attachment_context_not_sealed/u);
  assert.deepEqual(await fs.readdir(f.directory), before);
  assert.equal(await updatePendingAttachmentContext(f.directory, f.reference.path, "late complete"), true);
  await assert.rejects(fs.stat(attachmentFilePath(f.directory, f.reference.path)! + ".context"), { code: "ENOENT" });
});

for (const value of ["", "中".repeat(42666) + "ab"]) {
  test(`sealed context roundtrip byte boundary ${Buffer.byteLength(value)}`, async t => {
    const f = await filesFixture(t);
    await saveAttachmentContext(f.directory, f.reference.path, value);
    const bundle = await f.exportToFile();
    const imported = await importSessionFile(f.workspace, f.source);
    const event = (await readSessionEvents(imported.filePath)).find(e => e.type === "user_message");
    const ref = event!.attachments![0]!;
    assert.equal((await readSealedAttachmentContextBytes(f.directory, ref.path))?.toString("utf8"), value);
    assert.equal(bundle.attachments[0].context.size, Buffer.byteLength(value));
    assert.equal((await fs.stat(attachmentFilePath(f.directory, ref.path)! + ".context")).mode & 0o777, 0o600);
  });
}

for (const kind of ["bad-shape", "hash", "size", "oversize", "invalid-utf8"] as const) {
  test(`invalid context ${kind} refuses import without a session or attachment batch`, async t => {
    const f = await filesFixture(t);
    const bundle = await f.exportToFile();
    const bytes = kind === "invalid-utf8" ? Buffer.from([0xff]) : Buffer.from("context");
    let value: unknown = { data: bytes.toString("base64"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (kind === "bad-shape") value = null;
    else if (kind === "hash") (value as { sha256: string }).sha256 = "0".repeat(64);
    else if (kind === "size") (value as { size: number }).size = 2;
    else if (kind === "oversize") (value as { size: number }).size = 128001;
    bundle.version = 3;
    bundle.attachments[0].context = value;
    await writeFile(f.source, JSON.stringify(bundle));
    const before = await fs.readdir(f.directory);
    await assert.rejects(importSessionFile(f.workspace, f.source), /attachment_context_invalid/u);
    assert.deepEqual(await fs.readdir(f.directory), before);
    assert.equal((await listSessionFiles(f.workspace)).length, 1);
  });
}

test("sealed context symlink cannot export outside attachment root", async t => {
  const f = await filesFixture(t);
  const outside = path.join(f.root, "private.txt");
  await writeFile(outside, "outside");
  await fs.symlink(outside, attachmentFilePath(f.directory, f.reference.path)! + ".context");
  await assert.rejects(f.exportToFile(), /attachment_path_invalid/u);
});

test("sidecar failure and later session failure rollback both owned staged files", async t => {
  const f = await filesFixture(t);
  await saveAttachmentContext(f.directory, f.reference.path, context);
  await f.exportToFile();
  const before = (await fs.readdir(f.directory)).sort();
  const originalOpen = fs.open;
  for (const failing of [".context", ".jsonl"]) {
    t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]) => {
      if (String(file).endsWith(failing) && (failing === ".jsonl" || String(file).includes(`${path.sep}import-`))) throw Object.assign(new Error("injected write denial"), { code: "EACCES" });
      return await originalOpen(file, ...rest);
    });
    await assert.rejects(importSessionFile(f.workspace, f.source), /injected write denial/u);
    t.mock.restoreAll();
    assert.deepEqual((await fs.readdir(f.directory)).sort(), before);
    assert.equal((await listSessionFiles(f.workspace)).length, 1);
  }
});


test("v2 unknown context field is not interpreted as newly trusted attachment data", async t => {
  const f = await filesFixture(t);
  const bundle = await f.exportToFile();
  bundle.version = 2;
  bundle.attachments[0].context = { data: "invalid-new-shape" };
  await writeFile(f.source, JSON.stringify(bundle));
  const imported = await importSessionFile(f.workspace, f.source);
  const event = (await readSessionEvents(imported.filePath)).find(e => e.type === "user_message");
  assert.equal((await readAttachment(f.workspace, event!.attachments![0]!))?.hiddenContext, undefined);
});

for (const bytes of [Buffer.from([0xff]), Buffer.alloc(128001, 97)]) {
  test(`export rejects invalid sealed context (${bytes.length} bytes)`, async t => {
    const f = await filesFixture(t);
    await writeFile(attachmentFilePath(f.directory, f.reference.path)! + ".context", bytes);
    await assert.rejects(f.exportToFile(), /attachment_context_invalid/u);
  });
}

test("export bounds a sealed context that grows after stat to max plus one byte", async t => {
  const f = await filesFixture(t);
  await saveAttachmentContext(f.directory, f.reference.path, "small");
  const sidecar = attachmentFilePath(f.directory, f.reference.path)! + ".context";
  const open = fs.open;
  let bytesRead = 0, grew = false;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]) => {
    const handle = await open(file, ...rest);
    if (String(file) === sidecar) {
      const read = handle.read.bind(handle);
      handle.read = (async (...args: unknown[]) => {
        if (!grew) { grew = true; await fs.appendFile(sidecar, Buffer.alloc(500000, 97)); }
        const result = await Reflect.apply(read, handle, args);
        bytesRead += result.bytesRead;
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  await assert.rejects(f.exportToFile(), /attachment_context_invalid/u);
  assert.equal(grew, true);
  assert.equal(bytesRead, 128001);
});

test("image replaced while sidecar writes is rejected and replacement retained", async t => {
  const f = await filesFixture(t);
  await saveAttachmentContext(f.directory, f.reference.path, context);
  await f.exportToFile();
  const open = fs.open;
  let replacement: string | undefined;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]) => {
    const handle = await open(file, ...rest);
    if (String(file).endsWith(".context") && String(file).includes(`${path.sep}import-`)) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...args: Parameters<typeof handle.writeFile>) => {
        await write(...args);
        replacement = String(file).slice(0, -".context".length);
        await fs.rename(replacement, replacement + ".moved");
        await writeFile(replacement, "external replacement");
      };
    }
    return handle;
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), /attachment_import_file_replaced/u);
  assert.ok(replacement);
  assert.equal(await readFile(replacement, "utf8"), "external replacement");
  assert.equal((await listSessionFiles(f.workspace)).length, 1);
});

test("session-write rollback retains externally replaced context without publishing a session", async t => {
  const f = await filesFixture(t);
  await saveAttachmentContext(f.directory, f.reference.path, context);
  await f.exportToFile();
  const open = fs.open;
  let replacement: string | undefined;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], ...rest: [Parameters<typeof fs.open>[1], Parameters<typeof fs.open>[2]]) => {
    if (String(file).endsWith(".jsonl")) {
      const batch = (await fs.readdir(f.directory)).find(name => name.startsWith("import-"));
      assert.ok(batch);
      const parent = path.join(f.directory, batch);
      const contextName = (await fs.readdir(parent)).find(name => name.endsWith(".context"));
      assert.ok(contextName);
      replacement = path.join(parent, contextName);
      await fs.rename(replacement, replacement + ".moved");
      await writeFile(replacement, "external context");
      throw new Error("session refused");
    }
    return await open(file, ...rest);
  });
  await assert.rejects(importSessionFile(f.workspace, f.source), /session refused.*attachment_import_cleanup_uncertain/u);
  assert.ok(replacement);
  assert.equal(await readFile(replacement, "utf8"), "external context");
  assert.equal((await listSessionFiles(f.workspace)).length, 1);
});

test("two sealed contexts remain paired to their own pixels across workspace and repeated bundles", async t => {
  const f = await filesFixture(t);
  const second = await saveAttachment(f.workspace, "second.png", "image/png", Buffer.from("second pixels"));
  await saveAttachmentContext(f.directory, f.reference.path, "first context");
  await saveAttachmentContext(f.directory, second.path, "second context");
  await createSessionFile(f.workspace, "pair", Buffer.from(JSON.stringify({ type: "user_message", content: "compare", attachments: [f.reference, second] }) + "\n"));
  const original = JSON.parse((await exportSessionBundle(f.workspace, "pair")).content);
  await writeFile(f.source, JSON.stringify(original));
  const destination = path.join(f.root, "destination");
  await fs.mkdir(destination);
  await ensureAgentDirs(destination);
  const imported = await importSessionFile(destination, f.source);
  const again = JSON.parse((await exportSessionBundle(destination, imported.sessionId)).content);
  assert.equal(again.attachments.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(again.attachments[i].data, original.attachments[i].data);
    assert.deepEqual(again.attachments[i].context, original.attachments[i].context);
    assert.notEqual(again.attachments[i].sourcePath, original.attachments[i].sourcePath);
  }
  await refreshSessionIndex(destination);
});
