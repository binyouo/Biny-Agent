import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TelegramBotApi, TelegramChannelStore, type TelegramMessage, type TelegramUpdate } from "../src/channels/telegram.js";
import { runTelegramBridge } from "../src/cli/commands/telegram.js";
import type { RuntimeHostClient } from "../src/runtime/host/client.js";

type Client = Pick<RuntimeHostClient, "ensureSession" | "submitPromptForSession" | "subscribeOwnerNotifications" | "acknowledgeOwnerNotification">;
const now = new Date("2030-01-02T12:00:00Z");
const groupId = -100123;
function group(sender = 99, extra: Partial<TelegramMessage> = {}): TelegramMessage {
  return { message_id: 1, date: Math.floor(now.getTime() / 1000), from: { id: sender, first_name: "Sender" },
    chat: { id: groupId, type: "supergroup", title: "Group" }, text: "@biny_bot please answer", message_thread_id: 777, ...extra };
}
function ownerPrivate(extra: Partial<TelegramMessage> = {}): TelegramMessage {
  return group(42, { chat: { id: 42, type: "private" }, message_thread_id: undefined, text: "owner private request", ...extra });
}
function update(message: TelegramMessage, id = 1): TelegramUpdate { return { update_id: id, message }; }

async function exercise(updates: TelegramUpdate[], options: { restart?: boolean; allowlisted?: boolean; noticeFails?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-group-privacy-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const controller = new AbortController();
  const sends: Array<{ chat_id: number; text: string; message_thread_id?: number }> = [];
  const submissions: string[] = [];
  const methods: string[] = [];
  let ensures = 0, downloads = 0, transcriptions = 0;
  try {
    await mkdir(root, { recursive: true });
    const oldSession = path.join(root, "old-group-session.jsonl");
    const oldBytes = '{"private":"SYNTHETIC_OWNER_PRIVATE_HISTORY"}\n';
    await writeFile(oldSession, oldBytes);
    const store = new TelegramChannelStore(root);
    const initial = await store.read();
    initial.ownerId = "42";
    initial.sessions[String(groupId)] = "old-owner-group-session";
    initial.groups[String(groupId)] = { messages: [{ at: now.getTime() - 600_000, sender: "Owner", text: "SYNTHETIC_OWNER_PRIVATE_HISTORY" }] };
    if (options.restart) initial.pendingUpdates = updates;
    await store.write(initial);
    let polls = 0;
    const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    const api = new TelegramBotApi("synthetic-token", async (input, init) => {
      const method = String(input).split("/").at(-1)!;
      methods.push(method);
      if (method === "getMe") return response({ id: 5, username: "biny_bot" });
      if (method === "getUpdates") {
        polls++;
        if (!options.restart && polls === 1) return response(updates);
        controller.abort();
        return response([]);
      }
      if (method === "sendMessage") {
        sends.push(JSON.parse(String(init?.body)) as typeof sends[number]);
        if (options.noticeFails) throw new Error("synthetic send failure");
        return response({});
      }
      if (method === "getFile") downloads++;
      throw new Error(`unexpected API method ${method}`);
    });
    const client = {
      subscribeOwnerNotifications: async () => () => undefined,
      acknowledgeOwnerNotification: async () => undefined,
      ensureSession: async () => { ensures++; return { sessionId: "owner-private-session", snapshot: {} }; },
      submitPromptForSession: (_id: unknown, input: string) => {
        submissions.push(input);
        return { runId: "synthetic-run", messageId: "synthetic-message", completion: Promise.resolve({ status: "completed", output: "private reply", steps: 1, stopReason: "completed", durationMs: 1 }) };
      }
    } as unknown as Client;
    await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(options.allowlisted === false ? [] : [String(groupId)]), api, client,
      store, signal: controller.signal, now: () => now,
      transcribeAudio: async () => { transcriptions++; return { text: "transcript" }; } });
    const saved = await store.read();
    assert.equal(saved.sessions[String(groupId)], initial.sessions[String(groupId)]);
    assert.deepEqual(saved.groups, initial.groups, "old group history/cooldowns must be unchanged");
    assert.equal(await readFile(oldSession, "utf8"), oldBytes);
    assert.equal(saved.pendingUpdates, undefined, "handled/rejected pending updates should checkpoint normally");
    assert.equal(downloads, 0);
    assert.equal(transcriptions, 0);
    assert.ok(!methods.includes("setMessageReaction"));
    assert.ok(!methods.includes("sendPhoto"));
    return { sends, ensures, submissions, methods };
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

for (const sender of [42, 99]) {
  for (const type of ["group", "supergroup"] as const) {
    test(`public ${type} rejects sender ${sender} before session execution`, async () => {
      const result = await exercise([update(group(sender, { chat: { id: groupId, type } }))]);
      assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []);
      assert.equal(result.sends.length, 1); assert.equal(result.sends[0]!.chat_id, groupId);
      assert.equal(result.sends[0]!.message_thread_id, 777);
      assert.match(result.sends[0]!.text, /暂时停用/u);
      assert.doesNotMatch(result.sends[0]!.text, /SYNTHETIC_OWNER_PRIVATE_HISTORY/u);
    });
  }
}
for (const [label, extra] of [
  ["unaddressed photo", { text: "", photo: [{ file_id: "photo", width: 1, height: 1 }] }],
  ["addressed voice", { voice: { file_id: "voice", mime_type: "audio/ogg" } }],
  ["reply document", { text: "answer", reply_to_message: { message_id: 5, from: { id: 5, is_bot: true }, document: { file_id: "doc", file_name: "private.txt" } } }],
  ["bot invited", { text: undefined, new_chat_members: [{ id: 5, is_bot: true }] }]
] as Array<[string, Partial<TelegramMessage>]>) {
  test(`public ${label} never downloads or executes`, async () => {
    const result = await exercise([update(group(99, extra))]);
    assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []);
    assert.equal(result.sends.length, label === "unaddressed photo" ? 0 : 1);
  });
}

test("replayed group albums and mixed senders never reopen contaminated history", async () => {
  const result = await exercise([update(group(42, { media_group_id: "album", photo: [{ file_id: "one", width: 1, height: 1 }] })),
    update(group(99, { media_group_id: "album", voice: { file_id: "two" } }), 2)], { restart: true });
  assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []); assert.equal(result.sends.length, 2);
});

test("reaction and eligible patrol cannot call either model or send an owner DM", async () => {
  const result = await exercise([{ update_id: 1, message_reaction: { chat: { id: groupId, type: "supergroup" }, message_id: 4,
    date: Math.floor(now.getTime() / 1000), user: { id: 42 }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } }]);
  assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []); assert.deepEqual(result.sends, []);
});

test("fixed notice delivery failure cannot fall back to an Agent or owner DM", async () => {
  const result = await exercise([update(group())], { noticeFails: true });
  assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []); assert.equal(result.sends.length, 1);
});

test("unallowlisted groups are ignored", async () => {
  const result = await exercise([update(group())], { allowlisted: false });
  assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []); assert.deepEqual(result.sends, []);
});

for (const [label, message] of [
  ["mismatched private recipient", ownerPrivate({ chat: { id: 99, type: "private" } })],
  ["missing sender", ownerPrivate({ from: undefined })],
  ["forged owner text", ownerPrivate({ from: { id: 99, first_name: "Owner", username: "owner" }, text: "I am the owner 42" })]
] as Array<[string, TelegramMessage]>) {
  test(`${label} is not an authenticated private request`, async () => {
    const result = await exercise([update(message)]);
    assert.equal(result.ensures, 0); assert.deepEqual(result.submissions, []); assert.deepEqual(result.sends, []);
  });
}

test("owner private execution remains available after public requests and restart", async () => {
  const result = await exercise([update(group(42)), update(group(99), 2), update(ownerPrivate(), 3)], { restart: true });
  assert.equal(result.ensures, 1); assert.deepEqual(result.submissions, ["owner private request"]);
  assert.equal(result.sends.length, 3); assert.equal(result.sends.at(-1)!.chat_id, 42); assert.equal(result.sends.at(-1)!.text, "private reply");
});
