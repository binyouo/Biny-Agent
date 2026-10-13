import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentFilePath, attachmentRoot, readAttachment, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { tryReadSessionSnapshot } from "../src/session/sessionSnapshot.js";

type RootMode = "default" | "explicit" | "custom";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const context = "synthetic-private-attachment-context";
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
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  }));
  const reference = await saveAttachment(root, "picture.png", "image/png", png);
  await saveAttachmentContext(attachmentRoot(root), reference.path, context);
  const native = await readAttachment(root, reference);
  assert.ok(native);
  const directory = mode === "custom" ? path.join(root, "custom-attachments") : attachmentRoot(root);
  if (mode === "custom") await rename(attachmentRoot(root), directory);
  const open = async () => {
    local = await createInteractiveAgentHost(root, { configStore, attachmentRoot: mode === "default" ? undefined : directory });
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
  return { runtime, open, requests, images, first, info, directory, reference, native };
}

for (const mode of ["default", "explicit", "custom"] as const) {
  for (const operation of ["retry", "resume", "snapshot"] as const) {
    test(`real Runtime ${operation} restores the original image and context from the ${mode} attachment directory`, { timeout: 20_000 }, async (t) => {
      const f = await fixture(t, mode);
      const start = f.requests.length;
      if (operation === "retry") {
        const retried = f.runtime.submitPrompt("Inspect this picture", [], { retryOfMessageId: f.first.messageId });
        assert.equal((await retried.completion).status, "completed");
      } else {
        await f.runtime.close();
        const resumed = await f.open();
        const cold = await resumed.resumeSession(f.info.sessionId);
        assert.ok(cold.events.length > 0, "the first open must use full replay");
        if (operation === "snapshot") {
          // A normal read-only first open writes the snapshot asynchronously.
          // Do not manufacture one or append anything between the two opens.
          const fingerprint = await stat(f.info.sessionFile);
          const deadline = Date.now() + 2_000;
          while (!await tryReadSessionSnapshot(f.info.sessionFile, fingerprint)) {
            assert.ok(Date.now() < deadline, "the first open must persist its snapshot");
            await setTimeout(10);
          }
          const warm = await resumed.resumeSession(f.info.sessionId);
          assert.equal(warm.events.length, 0, "the second open must actually use the snapshot");
          assert.equal((await stat(f.info.sessionFile)).size, fingerprint.size, "read-only opens must not append events");
          assert.equal((await stat(f.info.sessionFile)).mtimeMs, fingerprint.mtimeMs);
        }
        assert.equal((await resumed.submitPrompt("Continue").completion).status, "completed");
      }
      assert.deepEqual(f.images(start), expected, `${operation} must retain the stored image rather than resolving an already physical attachment root again`);
      assert.ok(JSON.stringify(f.requests.slice(start)).includes(context), `${operation} must restore the matching hidden context`);
      const persisted = await readFile(f.info.sessionFile, "utf8");
      assert.ok(!persisted.includes(context));
      assert.ok(!persisted.includes(png.toString("base64")));
    });
  }
}

test("Runtime does not fall back to a different partition when the configured attachment is missing", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, "custom");
  await rm(attachmentFilePath(f.directory, f.reference.path)!);
  const start = f.requests.length;
  const retried = f.runtime.submitPrompt("Inspect this picture", [], { retryOfMessageId: f.first.messageId });
  assert.equal((await retried.completion).status, "completed");
  assert.deepEqual(f.images(start), []);
  assert.ok(!JSON.stringify(f.requests.slice(start)).includes(context));
});

// CI-only integration: this file imports the real Runtime and attachment store.
// Local restricted validation must only parse this source, never import it.
test("Runtime cold resume keeps a later picture on its user after an ordinary pause", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, "custom");
  const respond = globalThis.fetch;
  let reachedProvider!: () => void;
  const providerReached = new Promise<void>(resolve => { reachedProvider = resolve; });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().json();
    if (!JSON.stringify(body.messages).includes("Pause this text-only task")) return respond(request);
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason ?? new Error("Fixture request paused"));
      request.signal.addEventListener("abort", abort, { once: true });
      reachedProvider();
      if (request.signal.aborted) abort();
    });
  });
  const paused = f.runtime.submitPrompt("Pause this text-only task");
  await providerReached;
  assert.equal(f.runtime.cancelRun(paused.runId, "paused"), true);
  const pausedOutcome = await paused.completion;
  assert.equal(pausedOutcome.status, "cancelled");
  t.mock.method(globalThis, "fetch", respond);

  const picture = f.runtime.submitPrompt("Inspect the picture after the pause", [f.native]);
  assert.equal((await picture.completion).status, "completed");
  const facts = await readSessionEvents(f.info.sessionFile);
  const marker = facts.find(event => event.type === "turn_interrupted" && event.reason === "paused");
  assert.ok(marker?.type === "turn_interrupted", "the public cancellation must produce a durable pause marker");
  const pictureFact = facts.find(event => event.type === "user_message" && event.messageId === picture.messageId);
  assert.ok(pictureFact?.type === "user_message");
  assert.deepEqual(pictureFact.attachments, [f.reference]);
  assert.ok(facts.indexOf(pictureFact) > facts.indexOf(marker));

  await f.runtime.close();
  const resumed = await f.open();
  const cold = await resumed.resumeSession(f.info.sessionId);
  assert.ok(cold.events.length > 0, "this regression requires full replay, not a snapshot");
  const markerIndex = cold.messages.findIndex((message, index) => message.role === "user"
    && cold.messageReferences[index]?.id === undefined);
  assert.ok(markerIndex >= 0);
  assert.equal(cold.messages[markerIndex]!.content, marker.content, "the synthetic user must remain textual");
  const pictureIndex = cold.messageReferences.findIndex(reference => reference.id === picture.messageId);
  assert.ok(pictureIndex > markerIndex);
  const restored = cold.messages[pictureIndex];
  assert.ok(restored?.role === "user" && Array.isArray(restored.content));
  assert.deepEqual(restored.content.filter(part => part.type === "image"), [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" }
  ]);

  const start = f.requests.length;
  assert.equal((await resumed.submitPrompt("Continue after reopening").completion).status, "completed");
  const restoredUsers = f.requests.slice(start).flatMap(request => request.messages)
    .filter(message => message.role === "user" && Array.isArray(message.content)
      && message.content.some((part: { type: string; text?: string }) => part.type === "text" && part.text === "Inspect the picture after the pause"));
  assert.ok(restoredUsers.length > 0);
  for (const user of restoredUsers) {
    const parts = user.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(parts.filter(part => part.type === "image_url"), expected);
    assert.ok(JSON.stringify(parts).includes(context), "hidden context must stay with the matching image");
  }
  const persisted = await readFile(f.info.sessionFile, "utf8");
  assert.ok(!persisted.includes(context));
  assert.ok(!persisted.includes(png.toString("base64")));
});
