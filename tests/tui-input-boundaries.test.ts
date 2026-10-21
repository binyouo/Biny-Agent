import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import type { AgentAttachment } from "../src/agent/AgentSession.js";
import type { QueuedAgentMessage } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostClient, type HostOperationResult } from "../src/runtime/RuntimeHost.js";
import { SessionWriterConflictError } from "../src/runtime/SessionLease.js";
import { BinyTui } from "../src/tui/app.js";
import { loadInputHistory } from "../src/tui/inputHistory.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const accepted: HostOperationResult<QueuedAgentMessage> = {
  accepted: true, revision: 1, result: { runId: "run", messageId: "message", delivery: "steer" }
};
const image = (name: string): AgentAttachment => ({ name, mimeType: "image/png", data: "aW1hZ2U=" });

async function fixture(t: TestContext, delayWriteAccess = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-input-boundaries-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const terminal: Terminal = {
    start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
  const app = new BinyTui(new TUI(terminal), root);
  const admission = deferred<HostOperationResult<QueuedAgentMessage>>();
  const writeAccess = deferred<void>();
  if (!delayWriteAccess) writeAccess.resolve();
  const started = deferred<void>();
  const calls: Array<{ input: string; attachments: AgentAttachment[] }> = [];
  const history: string[] = [];
  const addToHistory = app["editor"].addToHistory.bind(app["editor"]);
  t.mock.method(app["editor"], "addToHistory", (value: string) => { history.push(value); addToHistory(value); });
  // Exercise the actual editor and TUI steer path, without starting the TUI,
  // runtime host, socket, clipboard, provider or a real terminal.
  const getSnapshot = () => ({ info: { sessionId: "session", sessionFile: "session.jsonl" }, state: { kind: "idle" } });
  const queue = async (input: string, attachments: AgentAttachment[]) => {
    calls.push({ input, attachments });
    started.resolve();
    return await admission.promise;
  };
  const runtime = Object.assign(Object.create(RuntimeHostClient.prototype) as RuntimeHostClient, {
      getSnapshot,
      ensureSession: async (options: { sessionId: string; writeIntent: boolean; focus: boolean }) => {
        assert.deepEqual(options, { sessionId: "session", writeIntent: true, focus: false });
        await writeAccess.promise;
        return { sessionId: "session", snapshot: getSnapshot() };
      },
      queueRunMessageForSession: async (sessionId: string, input: string, delivery: string, attachments: AgentAttachment[]) => {
        assert.equal(sessionId, "session");
        assert.equal(delivery, "steer");
        return await queue(input, attachments);
      },
      waitForIdle: async () => undefined,
      close: async () => undefined
    });
  app["runtime"] = runtime;
  t.after(async () => {
    // Successful admissions persist history asynchronously; keep all of it in
    // this fixture's temporary directory and drain it before removing the root.
    if (history.length) {
      const deadline = Date.now() + 5_000;
      while ((await loadInputHistory(root)).length < history.length) {
        assert.ok(Date.now() < deadline, "history did not finish writing");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await app.exit();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { app, editor: app["editor"], admission, started, calls, history, writeAccess };
}

{
  test(`Host: Backspace removes the latest pending attachment when the input is empty`, async (t) => {
    const { app, editor } = await fixture(t);
    app["setPendingAttachments"]([image("first.png"), image("last.png")]);
    editor.setText("");

    assert.deepEqual(app["handleGlobalKey"]("\x7f"), { consume: true });
    assert.deepEqual(app["pendingAttachments"], [image("first.png")]);
    assert.ok(app.tuiState.transcript.committed.some((item) => item.kind === "notification" && item.content === "已移除附件：last.png"));

    editor.setText("keep draft");
    assert.equal(app["handleGlobalKey"]("\x7f"), undefined, "Backspace with draft text stays with the Editor");
    assert.deepEqual(app["pendingAttachments"], [image("first.png")]);
  });

  test(`Host: steer expands a long bracketed paste before queueing and recording history`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls, history } = await fixture(t);
    const pasted = Array.from({ length: 11 }, (_, index) => `第${index + 1}行 👩🏽‍💻 cafe\u0301`).join("\n");
    editor.handleInput(`\u001b[200~${pasted}\u001b[201~`);
    assert.match(editor.getText(), /\[paste #1 \+11 lines\]/u, "fixture must use a collapsed paste");
    assert.equal(editor.getExpandedText(), pasted);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    admission.resolve(accepted);
    await steering;
    assert.equal(calls[0]?.input, pasted, "steer must send the content, not the editor's display marker");
    assert.deepEqual(history, [pasted]);
    assert.equal(editor.getText(), "");
  });

  test(`Host: steer admission preserves a newer draft and newly attached image`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls } = await fixture(t);
    const originalImage = image("original.png");
    const newerImage = image("newer.png");
    editor.setText("original steer");
    app["setPendingAttachments"]([originalImage]);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    editor.setText("next draft 👩🏽‍💻\ncafe\u0301");
    app["setPendingAttachments"]([...app["pendingAttachments"], newerImage]);
    admission.resolve(accepted);
    await steering;
    assert.deepEqual(calls, [{ input: "original steer", attachments: [originalImage] }]);
    assert.equal(editor.getExpandedText(), "next draft 👩🏽‍💻\ncafe\u0301", "admission must not erase a newer draft");
    assert.deepEqual(app["pendingAttachments"], [newerImage]);
  });

  test(`Host: rejected steer restores its input alongside a newer pasted draft and attachment`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, history } = await fixture(t);
    const originalImage = image("original.png");
    const newerImage = image("newer.png");
    const pasted = "newer pasted line\n".repeat(11).trimEnd();
    editor.setText("original steer");
    app["setPendingAttachments"]([originalImage]);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    editor.setText("");
    editor.handleInput(`\u001b[200~${pasted}\u001b[201~`);
    app["setPendingAttachments"]([...app["pendingAttachments"], newerImage]);
    admission.reject(new Error("steer rejected"));
    await steering;
    assert.equal(editor.getExpandedText(), `original steer\n${pasted}`);
    assert.deepEqual(app["pendingAttachments"], [originalImage, newerImage]);
    assert.deepEqual(history, [], "a rejected steer must not enter history");
    assert.ok(app.tuiState.transcript.committed.some((item) => item.kind === "error" && item.content === "steer rejected"));
  });


  test(`Host: repeated steer cannot queue the same pending input twice`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls } = await fixture(t);
    editor.setText("one steer");
    app["setPendingAttachments"]([image("one.png")]);
    const first = app["steerCurrentInput"]();
    await started.promise;
    const repeated = app["steerCurrentInput"]();
    admission.resolve(accepted);
    await Promise.all([first, repeated]);
    assert.equal(calls.length, 1);
    assert.equal(editor.getText(), "");
    assert.deepEqual(app["pendingAttachments"], []);
  });

  test(`Host: unedited rejection restores whitespace and attachments exactly once`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls, history } = await fixture(t);
    const original = "  original cafe\u0301 👩🏽‍💻  ";
    const attachments = [image("one.png"), image("two.png")];
    editor.setText(original);
    app["setPendingAttachments"](attachments);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    admission.reject(new Error("not accepted"));
    await steering;
    assert.equal(calls[0]?.input, original);
    assert.equal(editor.getExpandedText(), original);
    assert.deepEqual(app["pendingAttachments"], attachments);
    assert.deepEqual(history, []);
  });

  test(`Host: empty steer is inert and image-only steer preserves an empty user message`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls } = await fixture(t);
    editor.setText("  ");
    await app["steerCurrentInput"]();
    assert.deepEqual(calls, []);
    assert.equal(editor.getText(), "  ");
    app["setPendingAttachments"]([image("image-only.png")]);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    admission.resolve(accepted);
    await steering;
    assert.deepEqual(calls, [{ input: "  ", attachments: [image("image-only.png")] }]);
    assert.equal(editor.getText(), "");
    assert.deepEqual(app["pendingAttachments"], []);
  });

  test(`Host: text and image are submitted separately without generated attachment instructions`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started, calls } = await fixture(t);
    const original = "看一下这张图。";
    editor.setText(original);
    app["setPendingAttachments"]([image("screen.png")]);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    admission.resolve(accepted);
    await steering;

    assert.deepEqual(calls, [{ input: original, attachments: [image("screen.png")] }]);
  });

  test(`Host: undo cannot resurrect a submitted paste during admission or after success`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started } = await fixture(t);
    const pasted = "original 👩🏽‍💻 cafe\u0301\n".repeat(11).trimEnd();
    editor.handleInput(`\u001b[200~${pasted}\u001b[201~`);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    editor.handleInput("\u001f");
    assert.equal(editor.getExpandedText(), "", "submission must clear the old undo state like Enter");
    editor.setText("newer draft");
    editor.handleInput("\u001f");
    assert.equal(editor.getExpandedText(), "", "new-draft undo must stop at the submission boundary");
    admission.resolve(accepted);
    await steering;
    editor.handleInput("\u001f");
    assert.equal(editor.getExpandedText(), "");
  });

  test(`Host: undo while admission is pending does not duplicate a refused input`, { timeout: 5_000 }, async (t) => {
    const { app, editor, admission, started } = await fixture(t);
    const pasted = "original 👩🏽‍💻 cafe\u0301\n".repeat(11).trimEnd();
    editor.handleInput(`\u001b[200~${pasted}\u001b[201~`);
    app["setPendingAttachments"]([image("original.png")]);
    const steering = app["steerCurrentInput"]();
    await started.promise;
    editor.handleInput("\u001f");
    admission.reject(new Error("not accepted"));
    await steering;
    assert.equal(editor.getExpandedText(), pasted);
    assert.deepEqual(app["pendingAttachments"], [image("original.png")]);
  });

}

test("remote refusal restores only submitted text and images before the newer draft", { timeout: 5_000 }, async (t) => {
  const { app, editor, admission, started, history } = await fixture(t);
  const pasted = "👩🏽‍💻 cafe\u0301 ".repeat(110);
  editor.handleInput(`\u001b[200~${pasted}\u001b[201~`);
  assert.match(editor.getText(), /chars\]/u);
  app["setPendingAttachments"]([image("original.png")]);
  const steering = app["steerCurrentInput"]();
  await started.promise;
  editor.setText("newer draft");
  app["setPendingAttachments"]([...app["pendingAttachments"], image("newer.png")]);
  admission.resolve({ accepted: false, revision: 1, reason: "run ended before admission" });
  await steering;
  assert.equal(editor.getExpandedText(), `${pasted}\nnewer draft`);
  assert.deepEqual(app["pendingAttachments"], [image("original.png"), image("newer.png")]);
  assert.deepEqual(history, []);
  assert.ok(app.tuiState.transcript.committed.some((item) => item.kind === "error" && item.content === "run ended before admission"));
});

test("write-access rejection restores input before showing a writer conflict", { timeout: 5_000 }, async (t) => {
  const { app, editor, calls, history, writeAccess } = await fixture(t, true);
  editor.setText("original");
  app["setPendingAttachments"]([image("original.png")]);
  const conflict = new SessionWriterConflictError("session", 123, "cli");
  const shown: SessionWriterConflictError[] = [];
  // Keep the boundary test independent of stored-session reading and overlays.
  app["showSessionWriterConflict"] = async (error) => { shown.push(error as SessionWriterConflictError); };
  const steering = app["steerCurrentInput"]();
  editor.setText("newer 👩🏽‍💻");
  app["setPendingAttachments"]([...app["pendingAttachments"], image("newer.png")]);
  writeAccess.reject(conflict);
  await steering;
  assert.deepEqual(shown, [conflict]);
  assert.equal(editor.getExpandedText(), "original\nnewer 👩🏽‍💻");
  assert.deepEqual(app["pendingAttachments"], [image("original.png"), image("newer.png")]);
  assert.deepEqual(calls, [], "failed write access must not queue anything");
  assert.deepEqual(history, []);
});

test("short multiline paste, Unicode editing and ordinary Enter remain unchanged", { timeout: 5_000 }, async (t) => {
  const { editor } = await fixture(t);
  editor.handleInput("\u001b[200~first\r\n中文\tcafe\u0301 👩🏽‍💻\u001b[201~");
  assert.equal(editor.getExpandedText(), "first\n中文    cafe\u0301 👩🏽‍💻");
  editor.handleInput("\u007f");
  assert.equal(editor.getExpandedText(), "first\n中文    cafe\u0301 ", "backspace removes one complete emoji grapheme");
  editor.handleInput("\u007f");
  editor.handleInput("\u007f");
  assert.equal(editor.getExpandedText(), "first\n中文    caf", "backspace removes the combining accent with its letter");
  const submissions: string[] = [];
  editor.onSubmit = (text) => submissions.push(text);
  editor.handleInput("\r");
  assert.deepEqual(submissions, ["first\n中文    caf"]);
  assert.equal(editor.getExpandedText(), "");
  const longPaste = "long pasted line 👩🏽‍💻\n".repeat(11).trimEnd();
  editor.handleInput(`\u001b[200~${longPaste}\u001b[201~`);
  editor.handleInput("\r");
  assert.deepEqual(submissions, ["first\n中文    caf", longPaste]);
  assert.equal(editor.getExpandedText(), "");
});


for (const undoStack of [undefined, null, {}, { clear: "changed API" }]) {
  test("an unsupported editor undo contract preserves the draft without dispatch", { timeout: 5_000 }, async (t) => {
    const { app, editor, calls, history, admission } = await fixture(t);
    admission.resolve(accepted);
    const text = "  original 👩🏽‍💻 cafe\u0301  ";
    editor.setText(text);
    app["setPendingAttachments"]([image("original.png")]);
    Object.defineProperty(editor, "undoStack", { value: undoStack, configurable: true });
    await app["steerCurrentInput"]();
    assert.equal(editor.getExpandedText(), text);
    assert.deepEqual(app["pendingAttachments"], [image("original.png")]);
    assert.deepEqual(calls, []);
    assert.deepEqual(history, []);
    assert.ok(app.tuiState.transcript.committed.some((item) => item.kind === "error" && item.content.includes("submission reset is unavailable")));
  });
}

test("a failing undo reset restores the consumed draft and attachments without dispatch", { timeout: 5_000 }, async (t) => {
  const { app, editor, calls, history, admission } = await fixture(t);
  admission.resolve(accepted);
  editor.setText("original");
  app["setPendingAttachments"]([image("original.png")]);
  t.mock.method(editor["undoStack"], "clear", () => { throw new Error("undo reset failed"); });
  await app["steerCurrentInput"]();
  assert.equal(editor.getExpandedText(), "original");
  assert.deepEqual(app["pendingAttachments"], [image("original.png")]);
  assert.deepEqual(calls, []);
  assert.deepEqual(history, []);
  assert.ok(app.tuiState.transcript.committed.some((item) => item.kind === "error" && item.content === "undo reset failed"));
});

test("steer preserves a literal trailing backslash without calling the Enter callback", { timeout: 5_000 }, async (t) => {
  const { app, editor, admission, started, calls } = await fixture(t);
  editor.setText("literal backslash" + "\\");
  editor.disableSubmit = true;
  const enterCalls: string[] = [];
  editor.onSubmit = (text) => enterCalls.push(text);
  const steering = app["steerCurrentInput"]();
  await started.promise;
  admission.resolve(accepted);
  await steering;
  assert.equal(calls[0]?.input, "literal backslash" + "\\");
  assert.deepEqual(enterCalls, []);
  assert.equal(editor.disableSubmit, true);
  assert.equal(editor.getExpandedText(), "");
  editor.handleInput("\u001f");
  assert.equal(editor.getExpandedText(), "");
});
