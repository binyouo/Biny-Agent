import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TelegramBotApi, TelegramChannelStore } from "../src/channels/telegram.js";
import { runTelegramBridge } from "../src/cli/commands/telegram.js";

type BridgeOptions = Parameters<typeof runTelegramBridge>[0];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const update = { update_id: 11, message: { message_id: 11, date: 1_800_000_000,
  from: { id: 42 }, chat: { id: 42, type: "private" as const }, text: "Inert request" } };

for (const stage of ["session receipt", "session checkpoint"] as const) {
  await test(`stop during ${stage} leaves an unsubmitted message recoverable`, { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-telegram-admission-"));
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const reason = new Error("normal bridge stop");
    const store = new TelegramChannelStore(root);
    const write = store.write.bind(store);
    let submissions = 0;
    let polls = 0;
    let unsubscribeCalls = 0;
    let pending: Promise<void> | undefined;
    const makeApi = (signalController: AbortController) => new TelegramBotApi("inert-test-token", async (input) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 5 } });
      if (url.endsWith("/getUpdates")) {
        polls++;
        if (polls > 1) throw new Error("recovery must consume the persisted message before polling");
        return Response.json({ ok: true, result: [update] });
      }
      if (url.endsWith("/sendMessage")) { signalController.abort(); return Response.json({ ok: true, result: {} }); }
      throw new Error(`Unexpected inert API call: ${url}`);
    });
    const client: BridgeOptions["client"] = {
      subscribeOwnerNotifications: async () => () => { unsubscribeCalls++; },
      acknowledgeOwnerNotification: async () => { throw new Error("unexpected notification"); },
      ensureSession: async () => {
        if (stage === "session receipt") { entered.resolve(); await release.promise; }
        return { sessionId: "inert-session", snapshot: {} };
      },
      submitPromptForSession: (_sessionId: unknown, _input: unknown, _attachments: unknown, requestIds: unknown) => {
        assert.deepEqual(requestIds, { runId: "telegram-42-11", messageId: "telegram-message-42-11", turnId: "telegram-turn-42-11" });
        submissions++;
        return { runId: "inert-run", messageId: "inert-message", completion: Promise.resolve({
          status: "completed", output: "inert reply", stopReason: "completed", steps: 1, runId: "inert-run", durationMs: 1
        }) };
      }
    } as unknown as BridgeOptions["client"];
    store.write = async (state) => {
      await write(state);
      if (stage === "session checkpoint" && state.sessions["42"]) { entered.resolve(); await release.promise; }
    };
    try {
      pending = runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api: makeApi(controller), client, store, signal: controller.signal });
      const settled = pending.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      await entered.promise;
      controller.abort(reason);
      release.resolve();
      const result = await settled;
      assert.equal(submissions, 0, "a stopped bridge must not submit a new Host turn");
      assert.equal(result.error, reason);
      assert.equal(unsubscribeCalls, 1);
      const saved = await store.read();
      assert.deepEqual(saved.pendingUpdates?.map((item) => item.update_id), [11]);
      assert.equal(saved.nextUpdateId, undefined);
      assert.equal(saved.sessions["42"], "inert-session");
      store.write = write;
      const restarted = new AbortController();
      await runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api: makeApi(restarted), client,
        store: new TelegramChannelStore(root), signal: restarted.signal });
      assert.equal(submissions, 1);
      assert.equal(polls, 1);
      assert.equal(unsubscribeCalls, 2);
      const recovered = await store.read();
      assert.equal(recovered.nextUpdateId, 12);
      assert.deepEqual(recovered.pendingUpdates ?? [], []);
    } finally {
      release.resolve(); controller.abort();
      await pending?.catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

await test("stop after submission still settles and checkpoints the submitted message", { timeout: 15_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-telegram-admitted-"));
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const store = new TelegramChannelStore(root);
  let submissions = 0;
  let pending: Promise<void> | undefined;
  const api = new TelegramBotApi("inert-test-token", async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 5 } });
    if (url.endsWith("/getUpdates")) return Response.json({ ok: true, result: [update] });
    if (url.endsWith("/sendMessage")) {
      assert.equal(init?.signal?.aborted, true);
      throw controller.signal.reason;
    }
    throw new Error(`Unexpected inert API call: ${url}`);
  });
  const client = {
    subscribeOwnerNotifications: async () => () => {},
    acknowledgeOwnerNotification: async () => {},
    ensureSession: async () => ({ sessionId: "inert-session", snapshot: {} }),
    submitPromptForSession: () => {
      submissions++; entered.resolve();
      return { completion: release.promise.then(() => ({ status: "completed", output: "inert reply" })) };
    }
  } as unknown as BridgeOptions["client"];
  try {
    pending = runTelegramBridge({ ownerId: "42", allowedGroupIds: new Set(), api, client, store, signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("normal stop after admission"));
    release.resolve();
    await pending;
    assert.equal(submissions, 1);
    const saved = await store.read();
    assert.equal(saved.nextUpdateId, 12);
    assert.deepEqual(saved.pendingUpdates ?? [], [], "already-submitted work must not be replayed by the pre-admission fix");
  } finally {
    release.resolve(); controller.abort();
    await pending?.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
