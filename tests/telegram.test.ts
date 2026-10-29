import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../src/config/paths.js";
import { readAttachmentBytes } from "../src/attachments/store.js";
import { TelegramBotApi, TelegramChannelStore, sendTelegramOwnerNotification, shouldTelegramGroupMessageReachAgent, type TelegramMessage } from "../src/channels/telegram.js";
import { runTelegramBridge, telegramDmCommand } from "../src/cli/commands/telegram.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";

type TelegramTestClient = Pick<RuntimeHostClient,
  "ensureSession" | "submitPromptForSession" | "subscribeOwnerNotifications" | "acknowledgeOwnerNotification"
>;

await testTelegramLongPollingAndTokenRedaction();
await testTelegramMediaDownloadAndPhotoInput();
await testTelegramStaticAndAnimatedStickerInput();
await testTelegramMediaGroupAcrossPollsIsSubmittedTogether();
await testTelegramMediaGroupAcrossPollsIsSubmittedTogether(true);
await testTelegramVoiceTranscriptionInput();
await testTelegramVoiceWithoutTranscriptionDoesNotFailTheTurn();
await testTelegramCallbackQueryIsAcknowledged();
await testTelegramMessageSplitting();
await testTelegramPhotoUploadIsRestrictedToGeneratedImages();
await testTelegramSelfieAlbumPhotoIsOwnerPrivateOnly();
await testTelegramDirectMessageCommand();
await testTelegramOwnerNotificationDelivery();
await testTelegramBridgeRelaysOwnerNotificationAndAcknowledgesDelivery();
await testTelegramGroupAddressingGate();
await testTelegramStateRoundTrip();
await testTelegramRejectsOwnerMessagesInMismatchedPrivateChats();
await testTelegramBridgeSubmitsAndReplies();
console.log("telegram tests passed");

async function testTelegramLongPollingAndTokenRedaction(): Promise<void> {
  const token = "12345:secret-token";
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const api = new TelegramBotApi(token, async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ ok: true, result: [{ update_id: 9, message: privateMessage(9) }] });
  });

  const updates = await api.getUpdates(9);
  assert.equal(requestUrl, `https://api.telegram.org/bot${token}/getUpdates`);
  assert.deepEqual(requestBody, { offset: 9, timeout: 50, allowed_updates: ["message", "callback_query", "message_reaction"] });
  assert.equal(updates[0]?.update_id, 9);

  const failing = new TelegramBotApi(token, async () => jsonResponse({
    ok: false,
    description: `request failed for ${token}`
  }, 401));
  await assert.rejects(failing.getMe(), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), /\[redacted\]/u);
    assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    return true;
  });
}

async function testTelegramMediaDownloadAndPhotoInput(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-photo-input-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let submittedInput: string | undefined;
  let submittedAttachments: Array<{ mimeType: string; data: string; path: string }> = [];
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let polls = 0;
    const api = new TelegramBotApi("media-input-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        return jsonResponse({ ok: true, result: polls === 1 ? [{
          update_id: 31,
          message: {
            ...privateMessage(31),
            text: undefined,
            caption: "这张图里有什么？",
            photo: [
              { file_id: "small-photo", width: 10, height: 10, file_size: 100 },
              { file_id: "large-photo", width: 100, height: 100, file_size: 1_000 }
            ]
          }
        }] : [] });
      }
      if (url.endsWith("/getFile")) {
        const body = JSON.parse(String(init?.body)) as { file_id: string };
        assert.equal(body.file_id, "large-photo", "the largest Telegram photo variant is downloaded");
        return jsonResponse({ ok: true, result: { file_path: "photos/owner.png", file_size: imageBytes.length } });
      }
      if (url.endsWith("/file/botmedia-input-token/photos/owner.png")) return new Response(imageBytes);
      if (url.endsWith("/sendMessage")) {
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "photo-session", snapshot: {} }),
      submitPromptForSession: (
        _sessionId: string | undefined,
        input: string,
        attachments: Array<{ mimeType: string; data: string; path: string }>
      ) => {
        submittedInput = input;
        submittedAttachments = attachments;
        return {
          runId: "photo-run",
          messageId: "photo-message",
          completion: Promise.resolve({ status: "completed", stopReason: "completed", steps: 1, output: "这是一张图片。", runId: "photo-run", durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store: new TelegramChannelStore(workspace), signal: controller.signal });
    assert.equal(submittedInput, "这张图里有什么？");
    assert.equal(submittedAttachments.length, 1);
    assert.equal(submittedAttachments[0]?.mimeType, "image/png");
    assert.equal(submittedAttachments[0]?.data, imageBytes.toString("base64"));
    assert.match(submittedAttachments[0]?.path ?? "", /^@attachments\//u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramStaticAndAnimatedStickerInput(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-sticker-input-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  const staticStickerBytes = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary");
  const animatedStickerBytes = Buffer.from("telegram animated sticker bytes");
  const submitted: Array<{ input: string; attachments: Array<{ mimeType: string; data: string; path: string }> }> = [];
  let replyCount = 0;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let polled = false;
    const api = new TelegramBotApi("sticker-input-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        if (polled) return jsonResponse({ ok: true, result: [] });
        polled = true;
        return jsonResponse({ ok: true, result: [
          { update_id: 40, message: { ...privateMessage(40), text: undefined, sticker: { file_id: "static-sticker", emoji: "🦊", set_name: "fox_set", is_animated: false, is_video: false } } },
          { update_id: 41, message: { ...privateMessage(41), text: undefined, sticker: { file_id: "animated-sticker", emoji: "✨", set_name: "sparkle_set", is_animated: true, is_video: false } } }
        ] });
      }
      if (url.endsWith("/getFile")) {
        const body = JSON.parse(String(init?.body)) as { file_id: string };
        const fileId = body.file_id;
        return jsonResponse({ ok: true, result: {
          file_path: fileId === "static-sticker" ? "stickers/fox.webp" : "stickers/sparkle.tgs",
          file_size: fileId === "static-sticker" ? staticStickerBytes.length : animatedStickerBytes.length
        } });
      }
      if (url.includes("/file/botsticker-input-token/stickers/fox.webp")) return new Response(staticStickerBytes);
      if (url.includes("/file/botsticker-input-token/stickers/sparkle.tgs")) return new Response(animatedStickerBytes);
      if (url.endsWith("/sendMessage")) {
        replyCount += 1;
        if (replyCount === 2) controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "sticker-session", snapshot: {} }),
      submitPromptForSession: (_sessionId: string | undefined, input: string, attachments: Array<{ mimeType: string; data: string; path: string }>) => {
        submitted.push({ input, attachments });
        const runId = `sticker-run-${submitted.length}`;
        return {
          runId,
          messageId: `${runId}-message`,
          completion: Promise.resolve({ status: "completed", stopReason: "completed", steps: 1, output: "收到贴纸。", runId, durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store: new TelegramChannelStore(workspace), signal: controller.signal });
    assert.equal(submitted.length, 2);
    assert.match(submitted[0]?.input ?? "", /🦊; fox_set/u);
    assert.deepEqual(submitted[0]?.attachments.map(({ mimeType, data }) => ({ mimeType, data })), [{ mimeType: "image/webp", data: staticStickerBytes.toString("base64") }]);
    assert.match(submitted[0]?.attachments[0]?.path ?? "", /^@attachments\//u);
    assert.match(submitted[1]?.input ?? "", /✨; sparkle_set/u);
    assert.deepEqual(submitted[1]?.attachments.map(({ mimeType, data }) => ({ mimeType, data })), [{ mimeType: "application/x-tgsticker", data: "" }]);
    assert.match(submitted[1]?.attachments[0]?.path ?? "", /^@attachments\//u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramMediaGroupAcrossPollsIsSubmittedTogether(restartDuringCollection = false): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-album-input-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  let controller = new AbortController();
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const submittedAttachments: Array<{ mimeType: string; data: string }> = [];
  const updateOffsets: number[] = [];
  let submittedInput = "";
  let poll = 0;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    const api = new TelegramBotApi("album-input-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        const body = JSON.parse(String(init?.body)) as { offset?: number; timeout: number };
        updateOffsets.push(body.offset ?? 0);
        poll++;
        if (restartDuringCollection && poll === 2) {
          controller.abort();
          throw new Error("synthetic shutdown during album collection");
        }
        const message = (id: number, fileId: string, caption?: string) => ({
          ...privateMessage(id),
          text: undefined,
          caption,
          media_group_id: "album-1",
          photo: [{ file_id: fileId, width: 1, height: 1 }]
        });
        return jsonResponse({ ok: true, result: poll === 1
          ? [{ update_id: 70, message: message(70, "album-photo-1", "请看这组照片") }]
          : poll === (restartDuringCollection ? 3 : 2) ? [{ update_id: 71, message: message(71, "album-photo-2") }]
            : [] });
      }
      if (url.endsWith("/getFile")) {
        const body = JSON.parse(String(init?.body)) as { file_id: string };
        return jsonResponse({ ok: true, result: { file_path: `photos/${body.file_id}.png`, file_size: imageBytes.length } });
      }
      if (url.includes("/file/botalbum-input-token/photos/")) return new Response(imageBytes);
      if (url.endsWith("/sendMessage")) {
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "album-session", snapshot: {} }),
      submitPromptForSession: (_sessionId: string | undefined, input: string, attachments: Array<{ mimeType: string; data: string }>) => {
        submittedInput = input;
        submittedAttachments.push(...attachments);
        return {
          runId: "album-run",
          messageId: "album-message",
          completion: Promise.resolve({ status: "completed", stopReason: "completed", steps: 1, output: "收到这组照片。", runId: "album-run", durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    const store = new TelegramChannelStore(workspace);
    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store, signal: controller.signal });
    if (restartDuringCollection) {
      assert.equal(submittedAttachments.length, 0);
      assert.deepEqual((await store.read()).pendingUpdates?.map(update => update.update_id), [70]);
      controller = new AbortController();
      await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client,
        store: new TelegramChannelStore(workspace), signal: controller.signal });
      const recovered = await new TelegramChannelStore(workspace).read();
      assert.equal(recovered.pendingUpdates, undefined);
      assert.equal(recovered.nextUpdateId, 72);
    }
    assert.equal(submittedInput, "请看这组照片");
    assert.equal(submittedAttachments.length, 2, "album updates returned by separate polls are combined into one turn");
    assert.ok(submittedAttachments.every(attachment => attachment.mimeType === "image/png" && attachment.data === imageBytes.toString("base64")));
    assert.deepEqual(updateOffsets, restartDuringCollection ? [0, 71, 71, 72] : [0, 71, 72], "the bridge advances the offset after collecting every album item");
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramVoiceTranscriptionInput(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-voice-input-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  const audioBytes = Buffer.from("telegram voice bytes");
  let submittedInput: string | undefined;
  let submittedAttachments: unknown;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let polls = 0;
    const api = new TelegramBotApi("voice-input-token", async (input, _init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        return jsonResponse({ ok: true, result: polls === 1 ? [{
          update_id: 32,
          message: { ...privateMessage(32), text: undefined, voice: { file_id: "voice-file", mime_type: "audio/ogg" } }
        }] : [] });
      }
      if (url.endsWith("/getFile")) return jsonResponse({ ok: true, result: { file_path: "voice/owner.ogg", file_size: audioBytes.length } });
      if (url.endsWith("/file/botvoice-input-token/voice/owner.ogg")) return new Response(audioBytes);
      if (url.endsWith("/sendMessage")) {
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "voice-session", snapshot: {} }),
      submitPromptForSession: (_sessionId: string | undefined, input: string, attachments: unknown) => {
        submittedInput = input;
        submittedAttachments = attachments;
        return {
          runId: "voice-run",
          messageId: "voice-message",
          completion: Promise.resolve({ status: "completed", stopReason: "completed", steps: 1, output: "记好了。", runId: "voice-run", durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    await runTelegramBridge({
      ownerId: "42",
      allowedGroupIds: new Set(),
      api,
      client,
      store: new TelegramChannelStore(workspace),
      signal: controller.signal,
      transcribeAudio: async (file) => {
        assert.deepEqual(file.bytes, audioBytes);
        return { text: "帮我记一下", language: "zh" };
      }
    });
    assert.equal(submittedInput, "[Voice message transcription | spoken_language: zh] 帮我记一下");
    assert.deepEqual(submittedAttachments, [], "successfully transcribed voice is submitted as text");
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramVoiceWithoutTranscriptionDoesNotFailTheTurn(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-voice-untranscribed-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  let polls = 0;
  let submittedInput = "";
  let submittedAttachments: unknown[] = [];
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    const api = new TelegramBotApi("voice-untranscribed-token", async (input) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        return jsonResponse({ ok: true, result: polls === 1 ? [{
          update_id: 33,
          message: { ...privateMessage(33), text: undefined, voice: { file_id: "voice-file", mime_type: "audio/ogg" } }
        }] : [] });
      }
      if (url.endsWith("/getFile")) return jsonResponse({ ok: true, result: { file_path: "voice/owner.ogg" } });
      if (url.endsWith("/file/botvoice-untranscribed-token/voice/owner.ogg")) return new Response(Buffer.from("telegram voice bytes"));
      if (url.endsWith("/sendMessage")) {
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "voice-session", snapshot: {} }),
      submitPromptForSession: (_sessionId: string | undefined, input: string, attachments: unknown[]) => {
        submittedInput = input;
        submittedAttachments = attachments;
        return {
          runId: "voice-run",
          messageId: "voice-message",
          completion: Promise.resolve({ status: "completed", stopReason: "model_stop", steps: 1, output: "我收到了语音，但当前无法转写内容。", runId: "voice-run", durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    await runTelegramBridge({
      ownerId: "42",
      allowedGroupIds: new Set(),
      api,
      client,
      store: new TelegramChannelStore(workspace),
      signal: controller.signal
    });
    assert.match(submittedInput, /could not be transcribed/u);
    const attachmentPath = submittedInput.match(/@attachments\/[^ ;]+/u)?.[0];
    assert.ok(attachmentPath, "untranscribed OGG must keep a readable attachment reference");
    assert.deepEqual(await readAttachmentBytes(workspace, attachmentPath), Buffer.from("telegram voice bytes"));
    assert.deepEqual(submittedAttachments, [], "unsupported OGG audio must not fail AgentSession attachment validation");
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramCallbackQueryIsAcknowledged(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-callback-query-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  let answer: Record<string, unknown> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    let polls = 0;
    const api = new TelegramBotApi("callback-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        return jsonResponse({ ok: true, result: polls === 1 ? [{
          update_id: 41,
          callback_query: {
            id: "callback-1",
            from: { id: 42, first_name: "Owner" },
            message: { message_id: 7, chat: { id: 42, type: "private" }, text: "Choose" },
            data: "model:example"
          }
        }] : [] });
      }
      if (url.endsWith("/answerCallbackQuery")) {
        answer = JSON.parse(String(init?.body)) as Record<string, unknown>;
        controller.abort();
        return jsonResponse({ ok: true, result: true });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => { throw new Error("unsupported callback must not start an agent turn"); },
      submitPromptForSession: () => { throw new Error("unsupported callback must not start an agent turn"); }
    } as unknown as TelegramTestClient;
    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store: new TelegramChannelStore(workspace), signal: controller.signal });
    assert.deepEqual(answer, {
      callback_query_id: "callback-1",
      text: "该按钮在当前 Biny Telegram 渠道中不可用。"
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramMessageSplitting(): Promise<void> {
  const sent: string[] = [];
  const api = new TelegramBotApi("token", async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    sent.push(body.text ?? "");
    return jsonResponse({ ok: true, result: {} });
  });

  await api.sendMessage(-100123, "😀".repeat(4_001));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((part) => Array.from(part).length), [4_000, 1]);
}

async function testTelegramPhotoUploadIsRestrictedToGeneratedImages(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-image-gen-"));
  const filePath = path.join(directory, "image.png");
  const requests: Array<{ url: string; body: FormData }> = [];
  try {
    await writeFile(filePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const api = new TelegramBotApi("photo-token", async (input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ url: String(input), body: init.body });
      return jsonResponse({ ok: true, result: {} });
    });
    await api.sendPhoto(-100123, filePath, "刚拍好的照片");
    assert.equal(requests[0]?.url, "https://api.telegram.org/botphoto-token/sendPhoto");
    assert.equal(requests[0]?.body.get("chat_id"), "-100123");
    assert.equal(requests[0]?.body.get("caption"), "刚拍好的照片");
    const photo = requests[0]?.body.get("photo");
    assert.ok(photo instanceof File);
    assert.equal(photo.name, "image.png");
    await assert.rejects(api.sendPhoto(42, path.join(os.tmpdir(), "user-photo.png")), /Only images generated by Biny/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function testTelegramSelfieAlbumPhotoIsOwnerPrivateOnly(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-selfie-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const albumDirectory = path.join(globalConfigDir(), "selfies");
  const albumImage = path.join(albumDirectory, "selfie-2026-10-18T12-00-00-000Z-test.png");
  const outsideImage = path.join(root, "outside.png");
  const requests: Array<{ body: FormData }> = [];
  try {
    await mkdir(albumDirectory, { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await writeFile(albumImage, png);
    await writeFile(outsideImage, png);
    const api = new TelegramBotApi("selfie-token", async (_input, init) => {
      assert.ok(init?.body instanceof FormData);
      requests.push({ body: init.body });
      return jsonResponse({ ok: true, result: {} });
    });

    await api.sendOwnerSelfiePhoto(42, 42, albumImage);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.body.get("chat_id"), "42");
    await assert.rejects(api.sendOwnerSelfiePhoto(42, -100123, albumImage), /authenticated owner's private chat/u);
    await assert.rejects(api.sendPhoto(-100123, albumImage), /Only images generated by Biny/u);
    await assert.rejects(api.sendOwnerSelfiePhoto(42, 42, outsideImage), /approved selfie album images/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramDirectMessageCommand(): Promise<void> {
  let request: Record<string, unknown> | undefined;
  const api = new TelegramBotApi("dm-token", async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ ok: true, result: {} });
  });
  const originalLog = console.log;
  console.log = () => undefined;
  try { await telegramDmCommand("123456", "你好呀", api); }
  finally { console.log = originalLog; }
  assert.deepEqual(request, { chat_id: 123456, text: "你好呀" });
  await assert.rejects(telegramDmCommand("-100123", "不能发给群", api), /positive numeric user ID/u);
  await assert.rejects(telegramDmCommand("123456", " ", api), /must not be empty/u);
}

async function testTelegramOwnerNotificationDelivery(): Promise<void> {
  const previousToken = process.env.BINY_TELEGRAM_BOT_TOKEN;
  const previousOwner = process.env.BINY_TELEGRAM_OWNER_ID;
  let request: Record<string, unknown> | undefined;
  process.env.BINY_TELEGRAM_BOT_TOKEN = "notification-test-token";
  process.env.BINY_TELEGRAM_OWNER_ID = "42";
  try {
    const api = new TelegramBotApi("injected-token", async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ ok: true, result: {} });
    });
    assert.equal(await sendTelegramOwnerNotification("请看一下这件事。", api), true);
    assert.deepEqual(request, { chat_id: 42, text: "请看一下这件事。" });
    process.env.BINY_TELEGRAM_OWNER_ID = "-100123";
    assert.equal(await sendTelegramOwnerNotification("不能发往群聊。", api), false, "negative group IDs are not owner identities");
  } finally {
    if (previousToken === undefined) delete process.env.BINY_TELEGRAM_BOT_TOKEN; else process.env.BINY_TELEGRAM_BOT_TOKEN = previousToken;
    if (previousOwner === undefined) delete process.env.BINY_TELEGRAM_OWNER_ID; else process.env.BINY_TELEGRAM_OWNER_ID = previousOwner;
  }
}

async function testTelegramBridgeRelaysOwnerNotificationAndAcknowledgesDelivery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-owner-notification-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  const sent: Array<{ chat_id: number; text: string }> = [];
  const acknowledgements: Array<{ id: string; delivered: boolean; error?: string }> = [];
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    const api = new TelegramBotApi("owner-relay-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        controller.abort();
        return jsonResponse({ ok: true, result: [] });
      }
      if (url.endsWith("/sendMessage")) {
        sent.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string });
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "unused-session", snapshot: {} }),
      submitPromptForSession: () => { throw new Error("must not submit"); },
      subscribeOwnerNotifications: async (listener: (notification: { notificationId: string; text: string }) => Promise<void>) => {
        await listener({ notificationId: "notification-1", text: "Heartbeat needs your attention." });
        return () => undefined;
      },
      acknowledgeOwnerNotification: async (id: string, delivered: boolean, error?: string) => {
        acknowledgements.push({ id, delivered, error });
      }
    } as unknown as TelegramTestClient;
    await runTelegramBridge({
      ownerId: "42", allowedGroupIds: new Set(), api, client,
      store: new TelegramChannelStore(workspace), signal: controller.signal
    });
    assert.deepEqual(sent, [{ chat_id: 42, text: "Heartbeat needs your attention." }]);
    assert.deepEqual(acknowledgements, [{ id: "notification-1", delivered: true, error: undefined }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramGroupAddressingGate(): Promise<void> {
  const allowlist = new Set(["-100123"]);
  const mentioned = groupMessage(-100123, 42, "@biny_bot 你怎么看");
  assert.equal(shouldTelegramGroupMessageReachAgent(mentioned, 5, "biny_bot", allowlist), true);
  assert.equal(shouldTelegramGroupMessageReachAgent(groupMessage(-100123, 99, "@biny_bot hi"), 5, "biny_bot", allowlist), true,
    "any member can address Biny in an explicitly allowlisted group");
  assert.equal(shouldTelegramGroupMessageReachAgent(groupMessage(-200123, 42, "@biny_bot hi"), 5, "biny_bot", allowlist), false);
  assert.equal(shouldTelegramGroupMessageReachAgent(groupMessage(-100123, 42, "普通群消息"), 5, "biny_bot", allowlist), false);

  const reply = groupMessage(-100123, 42, "继续", { from: { id: 5, is_bot: true } });
  assert.equal(shouldTelegramGroupMessageReachAgent(reply, 5, "biny_bot", allowlist), true);
  const replyToAnotherBot = groupMessage(-100123, 42, "继续", { from: { id: 7, is_bot: true } });
  assert.equal(shouldTelegramGroupMessageReachAgent(replyToAnotherBot, 5, "biny_bot", allowlist), false,
    "a reply to another bot must not trigger Biny");
  const stickerReply = {
    ...groupMessage(-100123, 42, "", { from: { id: 5, is_bot: true } }),
    text: undefined,
    sticker: { file_id: "sticker-file", emoji: "🙂" }
  } satisfies TelegramMessage;
  assert.equal(shouldTelegramGroupMessageReachAgent(stickerReply, 5, "biny_bot", allowlist), true);
}

async function testTelegramStateRoundTrip(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-state-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    const store = new TelegramChannelStore(workspace);
    const state = await store.read();
    state.ownerId = "42";
    state.nextUpdateId = 10;
    state.sessions["-100123"] = "session-1";
    state.groups["-100123"] = { messages: [{ at: 1_800_000_000_000, sender: "owner", text: "hello" }], lastPatrolAt: 1_800_000_100_000 };
    await store.write(state);
    assert.deepEqual(await store.read(), state);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramRejectsOwnerMessagesInMismatchedPrivateChats(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-private-chat-id-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  let polls = 0;
  let sessions = 0;
  let submissions = 0;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    const api = new TelegramBotApi("private-chat-test-token", async (input) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        if (polls === 1) return jsonResponse({ ok: true, result: [{
          update_id: 1,
          message: { ...privateMessage(1), chat: { id: 123, type: "private" } }
        }] });
        controller.abort();
        return jsonResponse({ ok: true, result: [] });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => { sessions += 1; return { sessionId: "unexpected-session", snapshot: {} }; },
      submitPromptForSession: () => { submissions += 1; throw new Error("must not submit"); }
    } as unknown as TelegramTestClient;
    const store = new TelegramChannelStore(workspace);
    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store, signal: controller.signal });
    assert.equal(sessions, 0);
    assert.equal(submissions, 0);
    assert.equal((await store.read()).ownerId, "42", "the verified owner ID is persisted for local selfie authorization");
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function testTelegramBridgeSubmitsAndReplies(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-telegram-bridge-"));
  const workspace = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const controller = new AbortController();
  const sent: Array<{ kind: "message"; chat_id: number; text: string } | { kind: "photo"; chat_id: string; caption: string | undefined }> = [];
  const albumImagePath = path.join(root, "agent", "selfies", "selfie-2026-10-18T12-00-00-000Z-test.png");
  let submittedInput: string | undefined;
  let submittedPromptContext: string | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await mkdir(path.dirname(albumImagePath), { recursive: true });
    await writeFile(albumImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const api = new TelegramBotApi("bridge-test-token", async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 5, username: "biny_bot" } });
      if (url.endsWith("/getUpdates")) return jsonResponse({ ok: true, result: [{ update_id: 11, message: privateMessage(11) }] });
      if (url.endsWith("/sendMessage")) {
        sent.push({ kind: "message", ...JSON.parse(String(init?.body)) as { chat_id: number; text: string } });
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      if (url.endsWith("/sendPhoto")) {
        const body = init?.body as FormData;
        sent.push({ kind: "photo", chat_id: String(body.get("chat_id")), caption: body.get("caption")?.toString() });
        controller.abort();
        return jsonResponse({ ok: true, result: {} });
      }
      throw new Error(`unexpected Telegram API URL ${url}`);
    });
    const client = {
      ...noOwnerNotifications(),
      ensureSession: async () => ({ sessionId: "session-telegram-owner", snapshot: {} }),
      submitPromptForSession: (_sessionId: string | undefined, input: string, _attachments: unknown, _requestIds: unknown, promptContext: string) => {
        submittedInput = input;
        submittedPromptContext = promptContext;
        return {
          runId: "run",
          messageId: "message",
          completion: Promise.resolve({ status: "completed", stopReason: "completed", steps: 1, output: `hello from Biny\n\n![自拍](<${albumImagePath}>)`, runId: "run", durationMs: 1 })
        };
      }
    } as unknown as TelegramTestClient;

    await runTelegramBridge({
      ownerId: "42",
      allowedGroupIds: new Set(),
      api,
      client,
      store: new TelegramChannelStore(workspace),
      signal: controller.signal
    });

    assert.equal(submittedInput, "hello");
    assert.match(submittedPromptContext ?? "", /authenticated owner's private Telegram chat/u);
    assert.match(submittedPromptContext ?? "", /plain text without Markdown/u);
    assert.deepEqual(sent, [{ kind: "photo", chat_id: "42", caption: "hello from Biny" }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

function privateMessage(id: number): TelegramMessage {
  return {
    message_id: id,
    date: 1_800_000_000,
    from: { id: 42, first_name: "Owner" },
    chat: { id: 42, type: "private" },
    text: "hello"
  };
}

function groupMessage(
  chatId: number,
  userId: number,
  text: string,
  replyTo?: TelegramMessage["reply_to_message"]
): TelegramMessage {
  return {
    message_id: 1,
    date: 1_800_000_000,
    from: { id: userId, first_name: "Owner" },
    chat: { id: chatId, type: "supergroup", title: "Allowed group" },
    text,
    reply_to_message: replyTo
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function noOwnerNotifications() {
  return {
    subscribeOwnerNotifications: async () => () => undefined,
    acknowledgeOwnerNotification: async () => undefined
  };
}
