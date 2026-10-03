import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider, Container, Editor, TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfigFile } from "../src/config/loader.js";
import { globalConfigDir } from "../src/config/paths.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost, type RuntimeHostClient, type RuntimeHostFactory } from "../src/runtime/RuntimeHost.js";
import { slashCommandsForSurface } from "../src/runtime/commandRegistry.js";
import { readSessionEvents } from "../src/session/events.js";
import { BinyTui } from "../src/tui/app.js";
import { SelectDialog } from "../src/tui/components/dialogs.js";
import { PendingAttachmentsComponent } from "../src/tui/components/pendingAttachments.js";
import { SessionWriterConflictComponent } from "../src/tui/components/sessionWriterConflict.js";

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the observable result");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function terminal(): Terminal {
  return {
    start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
}

test("command picker executes the chosen command without a second submission", async () => {
  const ui = new TUI(terminal());
  const app = new BinyTui(ui, "/unused");
  let dialog: Component | undefined;
  const show = ui.showOverlay.bind(ui);
  ui.showOverlay = (component, options) => { dialog = component; return show(component, options); };
  try {
    await app.submit("/");
    assert.ok(dialog instanceof SelectDialog);
    // Given the command picker is open, When its selection callback confirms
    // /theme, Then that command opens its own picker immediately.
    dialog.handleInput("/theme");
    dialog.handleInput("\r");
    assert.match(dialog.render(80).join("\n"), /Terminal theme/u);
  } finally { await app.exit(); }
});

test("TUI serializes admissions, queues follow-ups and preserves the next draft", { timeout: 15_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-tui-submit-")));
  let firstResponse: ServerResponse | undefined;
  const sendReply = (response: ServerResponse, content: string): void => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const content = body.includes("tui-send-probe") ? "tui-send-reply" : "[]";
    if (content === "tui-send-reply" && !firstResponse) firstResponse = response;
    else sendReply(response, content);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "local-test",
    providers: { local: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`, requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: { "local-test": { provider: "local", model: "local-test", contextWindow: 128000, capabilities: { tools: true, reasoning: false, streaming: true } } },
    thinking: { ...defaultConfig.thinking, enabled: false },
    chat: { ...defaultConfig.chat, defaultToolSelection: "all", defaultSkillSelection: "all" },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  });
  await saveConfigFile(globalConfigDir(), config);
  let announceDraft!: () => void;
  let releaseDraft!: () => void;
  const draftStarted = new Promise<void>(resolve => { announceDraft = resolve; });
  const draftReady = new Promise<void>(resolve => { releaseDraft = resolve; });
  let holdFirstDraft = true;
  const factory: RuntimeHostFactory = async (sessionId, options) => {
    if (options?.fresh && holdFirstDraft) {
      holdFirstDraft = false;
      announceDraft();
      await draftReady;
    }
    const host = await createInteractiveAgentHost(root, {
      sessionId: options?.fresh ? sessionId : undefined,
      resourceRegistry: options?.resourceRegistry,
      resourceBoot: "background"
    });
    if (sessionId && !options?.fresh) await host.runtime.resumeSession(sessionId);
    return host;
  };
  const host = await startRuntimeHost(root, (resourceRegistry) => factory(undefined, { resourceRegistry }), {
    createRuntime: factory, resumeInterrupted: false, configDir: globalConfigDir()
  });
  const ui = new TUI(terminal());
  let dialog: Component | undefined;
  const show = ui.showOverlay.bind(ui);
  ui.showOverlay = (component, options) => { dialog = component; return show(component, options); };
  let listener: Parameters<TUI["addInputListener"]>[0] | undefined;
  const addListener = ui.addInputListener.bind(ui);
  ui.addInputListener = (inputListener) => { listener = inputListener; return addListener(inputListener); };
  const app = new BinyTui(ui, root);
  const running = app.run();
  let observer: RuntimeHostClient | undefined;
  try {
    const composer = ui.children.find((component) => component instanceof Container && component.children.some((child) => child instanceof Editor));
    assert.ok(composer instanceof Container);
    const editor = composer.children.find((component) => component instanceof Editor);
    const attachments = composer.children.find((component) => component instanceof PendingAttachmentsComponent);
    assert.ok(editor instanceof Editor);
    assert.ok(attachments instanceof PendingAttachmentsComponent);
    // The socket is attached while the new session is still initializing. A
    // submission here must wait for that session instead of using the primary.
    await draftStarted;
    const previousInfo = host.getCurrentRuntime().getSnapshot().info;
    await host.getCurrentRuntime().submitPrompt("previous-session-probe").completion;
    const first = app.submit("tui-send-probe first message");
    editor.setText("next draft");
    await Promise.resolve();
    releaseDraft();
    await first;
    await waitUntil(() => firstResponse !== undefined);
    const events = await readSessionEvents(app.tuiState.sessionFile);
    const errors = app.tuiState.transcript.committed.filter((item) => item.kind === "error" || item.kind === "notification");
    assert.ok(events.some((event) => event.type === "user_message" && event.content === "tui-send-probe first message"), JSON.stringify(errors));
    assert.notEqual(app.tuiState.sessionId, previousInfo.sessionId);
    assert.equal(app.tuiState.transcript.committed.some((item) => item.kind === "user" && item.content === "previous-session-probe"), false,
      "启动期间旧会话的缓存消息不能混入新聊天");
    assert.deepEqual((await readSessionEvents(previousInfo.sessionFile)).filter((event) => event.type === "user_message").map((event) => event.content),
      ["previous-session-probe"], "新消息不能追加到已有会话");
    const preservedDraft = editor.getText();
    const followUps = [
      app.submit("tui-send-probe follow-up one"),
      app.submit("tui-send-probe follow-up two")
    ];
    await Promise.all(followUps);
    sendReply(firstResponse!, "tui-send-reply");
    let stored = await readSessionEvents(app.tuiState.sessionFile);
    await waitUntil(async () => {
      stored = await readSessionEvents(app.tuiState.sessionFile);
      return stored.filter((event) => event.type === "user_message").length === 2
        && stored.filter((event) => event.type === "turn_status" && event.status === "completed").length === 2;
    }).catch((error) => {
      assert.fail(`${String(error)}\n${JSON.stringify(stored.filter((event) => event.type === "user_message").map((event) => event.content))}\n${JSON.stringify(app.tuiState.transcript.committed.filter((item) => item.kind === "error" || item.kind === "notification"))}`);
    });
    assert.deepEqual(stored.filter((event) => event.type === "user_message").map((event) => event.content), [
      "tui-send-probe first message", "tui-send-probe follow-up one\n\ntui-send-probe follow-up two"
    ], JSON.stringify(app.tuiState.transcript.committed.filter((item) => item.kind === "error")));
    assert.equal(preservedDraft, "next draft", "startup and admission must preserve the next draft");
    assert.ok(stored.some((event) => event.type === "assistant_message" && event.content.includes("tui-send-reply")));
    assert.deepEqual(app.tuiState.transcript.committed.filter((item) => item.kind === "error"), []);
    observer = await connectRuntimeHost(root, { clientId: "observer", surface: "cli" });
    assert.ok(observer);
    await observer.waitForIdle(app.tuiState.sessionId);

    await Promise.all([
      app.submit("tui-send-probe rapid one"),
      app.submit("tui-send-probe rapid two")
    ]);
    await waitUntil(async () => {
      stored = await readSessionEvents(app.tuiState.sessionFile);
      return stored.filter((event) => event.type === "turn_status" && event.status === "completed").length === 4;
    }).catch((error) => assert.fail(`${String(error)}\n${JSON.stringify(stored.filter((event) => event.type === "user_message").map((event) => event.content))}\n${JSON.stringify(app.tuiState.transcript.committed.filter((item) => item.kind === "error" || item.kind === "notification"))}`));
    assert.deepEqual(stored.filter((event) => event.type === "user_message").slice(-2).map((event) => event.content), [
      "tui-send-probe rapid one", "tui-send-probe rapid two"
    ]);
    assert.deepEqual(app.tuiState.transcript.committed.filter((item) => item.kind === "error"), []);
    await observer.waitForIdle(app.tuiState.sessionId);

    // The unit contract goes through the installed input listener and the real
    // framework Editor; no terminal rendering or manual acceptance is inferred.
    assert.ok(listener);
    const submitted: string[] = [];
    editor.onSubmit = (text) => submitted.push(text);
    const input = (data: string): void => {
      const result = listener!(data);
      if (!result?.consume) editor.handleInput(result?.data ?? data);
    };
    for (const prefix of ["/the", "/suba", "/skill:demo"]) {
      editor.setText("");
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
        ...slashCommandsForSurface("tui").map((command) => ({ name: command.name.slice(1), description: command.description })),
        { name: "skill:demo", description: "Demo skill" }
      ], root));
      for (const char of prefix) input(char);
      await waitUntil(() => editor.isShowingAutocomplete());
      input("\r");
      if (prefix === "/suba") assert.equal(editor.getText(), "/subagent ");
      else assert.equal(submitted.at(-1), prefix === "/the" ? "/theme" : "/skill:demo");
    }
    editor.setText("");
    for (const char of "/the") input(char);
    await waitUntil(() => editor.isShowingAutocomplete());
    const beforeTab = submitted.length;
    input("\t");
    assert.equal(editor.getText(), "/theme ");
    assert.equal(submitted.length, beforeTab, "Tab completes without submitting");
    editor.setText("");
    input("/");
    await waitUntil(() => editor.isShowingAutocomplete());
    input("\u001b[B");
    input("\r");
    assert.equal(submitted.at(-1), "/usage", "bare slash respects the highlighted command");

    await app.submit("/");
    assert.ok(dialog instanceof SelectDialog);
    dialog.handleInput("/subagent");
    dialog.handleInput("\r");
    assert.equal(editor.getText(), "/subagent ", "required arguments remain editable after picker selection");

    const competitor = await connectRuntimeHost(root, { clientId: "other-writer", surface: "cli" });
    assert.ok(competitor);
    try {
      await competitor.ensureSession({ sessionId: app.tuiState.sessionId, writeIntent: true });
      const rejected = app.submit("rejected message", [{ name: "original.png", mimeType: "image/png", data: "b3JpZ2luYWw=" }]);
      editor.setText("newer draft");
      await rejected;
      assert.equal(editor.getText(), "rejected message\nnewer draft");
      assert.match(attachments.render(80).join("\n"), /\[Image #1\]/u);
      const afterRejection = await readSessionEvents(app.tuiState.sessionFile);
      assert.equal(afterRejection.some((event) => event.type === "user_message" && event.content.includes("rejected message")), false);
    } finally { await competitor.close(); }
    const conflict = composer.children.find((component) => component instanceof SessionWriterConflictComponent);
    assert.ok(conflict instanceof SessionWriterConflictComponent);
    conflict.handleInput("\r");
    await waitUntil(() => composer.children.includes(editor));
    assert.equal(editor.getText(), "rejected message\nnewer draft", "retrying write access does not resend or discard the draft");
    assert.match(attachments.render(80).join("\n"), /\[Image #1\]/u);
  } finally {
    releaseDraft();
    await app.exit();
    await running;
    await observer?.close();
    await host.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
