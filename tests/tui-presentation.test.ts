import assert from "node:assert/strict";
import { test } from "node:test";
import { CombinedAutocompleteProvider, CURSOR_MARKER, TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { BinyTui } from "../src/tui/app.js";
import { ToolExecutionComponent } from "../src/tui/components/messages.js";
import { TranscriptView } from "../src/tui/components/transcriptView.js";
import { FooterComponent, WelcomeComponent } from "../src/tui/components/chrome.js";
import { PermissionDialog } from "../src/tui/components/dialogs.js";
import type { ToolTranscriptItem } from "../src/tui/types.js";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "").replaceAll(CURSOR_MARKER, "");
function ui(): TUI {
  const terminal: Terminal = {
    start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
  return new TUI(terminal);
}
function tool(id: string): ToolTranscriptItem {
  return {
    id, kind: "tool", tool: "Bash", title: "Ran tests", argsSummary: "pnpm private-tests",
    status: "success", durationMs: 1200, outputLines: 3, exitCode: 0,
    output: "passed one\npassed two\npassed three",
    details: "Command: pnpm private-tests\nExit code: 0\nstdout:\npassed one\npassed two\npassed three"
  };
}

test("consecutive tools occupy one row each and keep private details folded", () => {
  const view = new TranscriptView();
  view.sync({ committed: [tool("a"), tool("b"), tool("c")], active: [] });
  const lines = view.render(80).map(plain);
  assert.equal(lines.filter((line) => line.trim()).length, 3);
  assert.equal(lines.length, 4, "only the first tool gets a separating blank row");
  assert.match(lines.join("\n"), /3 lines/u);
  assert.doesNotMatch(lines.join("\n"), /private-tests|passed one/u);
});

test("Ctrl+O follows the latest tool or command card and updates details without exposing reasoning", () => {
  const app = new BinyTui(ui(), "/unused");
  // Feed the same immutable transcript used by live events and restored sessions.
  app["state"].transcript = { committed: [tool("a"), { id: "reasoning", kind: "reasoning", content: "private reasoning", durationMs: 1000 }], active: [] };
  app["chatContainer"].sync(app.tuiState.transcript);
  assert.doesNotMatch(plain(app["chatContainer"].render(80).join("\n")), /Command:/u);
  assert.deepEqual(app["handleGlobalKey"]("\u000f"), { consume: true });
  assert.match(plain(app["chatContainer"].render(80).join("\n")), /Command: pnpm private-tests/u);
  assert.doesNotMatch(plain(app["chatContainer"].render(80).join("\n")), /private reasoning/u);
  app["chatContainer"].invalidate();
  assert.match(plain(app["chatContainer"].render(80).join("\n")), /Exit code: 0/u);
  app["handleGlobalKey"]("\u000f");
  assert.doesNotMatch(plain(app["chatContainer"].render(80).join("\n")), /Command:/u);
  const card = { id: "card", kind: "card" as const, command: "/status", title: "Status", data: { sections: [{ rows: [{ label: "Detail", value: "card-secret", detail: true }] }] } };
  app["state"].transcript = { committed: [tool("a"), card], active: [] };
  app["chatContainer"].sync(app.tuiState.transcript);
  app["handleGlobalKey"]("\u000f");
  assert.match(plain(app["chatContainer"].render(80).join("\n")), /card-secret/u);
});

test("rounded editor preserves native Unicode input, cursor markers, wrapping and history", () => {
  const app = new BinyTui(ui(), "/unused");
  const editor = app["editor"];
  editor.focused = true;
  editor.setText("/model 中文 👩🏽‍💻 cafe\u0301");
  editor.handleInput(" ");
  assert.equal(editor.getText(), "/model 中文 👩🏽‍💻 cafe\u0301 ");
  editor.handleInput("\u007f");
  assert.equal(editor.getText(), "/model 中文 👩🏽‍💻 cafe\u0301");
  for (let width = 1; width <= 80; width += 1) {
    const lines = editor.render(width);
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1, `cursor at width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${plain(line)}`);
    if (width >= 10) assert.match(plain(lines[0]!), /^╭.*╮$/u);
  }
  editor.addToHistory("previous draft");
  editor.setText("");
  editor.handleInput("\u001b[A");
  assert.equal(editor.getText(), "previous draft");
  let submitted = "";
  editor.onSubmit = (value) => { submitted = value; };
  editor.handleInput("\r");
  assert.equal(submitted, "previous draft");
});

test("first Ctrl+C shows an expiring hint without changing the double-press window", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
  const app = new BinyTui(ui(), "/unused");
  const status = app["status"];
  try {
    app["handleGlobalKey"]("\u0003");
    assert.match(plain(status.render(80)[0]!), /Ctrl\+C 再按一次退出/u);
    t.mock.timers.tick(501);
    assert.doesNotMatch(plain(status.render(80)[0]!), /再按一次退出/u);
  } finally { status.dispose(); }
});

test("welcome stays within narrow and wide Unicode terminals", () => {
  const welcome = new WelcomeComponent("/workspace/中文项目", "0.2.2");
  for (let width = 1; width <= 100; width += 1) {
    for (const line of welcome.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${plain(line)}`);
  }
});

test("permission preview shows a bounded diff without consuming digits as approval", () => {
  const answers: string[] = [];
  const dialog = new PermissionDialog({
    tool: "Edit", title: "Edit config", details: "", requireFullYes: true,
    actionType: "file_write", riskLevel: "critical", targetPath: "config.json",
    diff: "--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-old value\n+new value"
  }, (answer) => answers.push(answer), () => undefined, 20);
  assert.match(plain(dialog.render(80).join("\n")), /\+new value/u);
  dialog.handleInput("1");
  assert.deepEqual(answers, []);
  assert.match(plain(dialog.render(80).join("\n")), /Enter/u);
});

test("queued messages use the existing status row and disappear after snapshot reconciliation", () => {
  const app = new BinyTui(ui(), "/unused");
  app["runtimeSnapshot"] = { state: { kind: "idle" }, queuedMessages: [{ messageId: "a" }, { messageId: "b" }] } as never;
  app["refreshChrome"]();
  assert.deepEqual(app["status"].render(80).map(plain), ["2 queued"]);
  app["runtimeSnapshot"] = { state: { kind: "idle" }, queuedMessages: [] } as never;
  app["refreshChrome"]();
  assert.deepEqual(app["status"].render(80), [""]);
});


test("footer fits shortcuts beside workspace and drops hints before telemetry on narrow terminals", () => {
  const data = { cwd: "/w", sessionId: "s", modelLabel: "model", permissionMode: "ask" as const, contextUsedTokens: 25, contextMaxTokens: 100 };
  const footer = new FooterComponent(data);
  assert.equal(footer.render(100).length, 2);
  assert.match(plain(footer.render(100)[0]!), /ctrl\+o details/u);
  const narrow = footer.render(20).map(plain);
  assert.doesNotMatch(narrow[0]!, /ctrl\+o/u);
  assert.match(narrow[1]!, /ctx 25%/u);
});

test("long permission diffs cannot wrap away the confirmation controls", () => {
  const dialog = new PermissionDialog({
    tool: "Edit", title: "Edit config", details: "", requireFullYes: true,
    actionType: "file_write", riskLevel: "critical", targetPath: "config.json",
    diff: Array.from({ length: 50 }, () => `+${"x".repeat(100)}`).join("\n")
  }, () => undefined, () => undefined, 25);
  const lines = dialog.render(40).map(plain);
  assert.ok(lines.length <= 30, `${lines.length} rows overflow the dialog`);
  assert.match(lines.join("\n"), /输入 yes/u);
  assert.match(lines.join("\n"), /Enter/u);
});


test("expanded running output follows immutable updates, stays bounded and cannot inject a cursor", () => {
  const view = new TranscriptView();
  const item = { ...tool("live"), status: "running" as const, details: "Command: test", startedAtMs: 10_000 };
  view.sync({ committed: [], active: [item] });
  const component = view.componentFor("live") as ToolExecutionComponent;
  component.toggleDetails();
  view.sync({ committed: [], active: [{ ...item, details: `Command: test\nExit code: 0\n${CURSOR_MARKER}\u001b[2J${"a very long result ".repeat(2000)}` }] });
  for (const width of [1, 10, 40, 80]) {
    const lines = view.render(width);
    assert.ok(lines.length <= 14, `bounded details at ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.ok(!lines.join("").includes(CURSOR_MARKER));
    assert.ok(!lines.join("").includes("\u001b[2J"));
  }
  assert.match(plain(view.render(80).join("\n")), /details truncated/u);
  component.toggleDetails();
  assert.doesNotMatch(plain(view.render(80).join("\n")), /Command:|Exit code:/u);
});

test("committed diff stats exclude patch headers and failed output stays bounded", () => {
  const edited = new ToolExecutionComponent({ ...tool("edit"), fileChange: {
    committed: true, operation: "update", path: "config.json",
    diff: "--- a/config.json\n+++ b/config.json\n@@ -1,2 +1,3 @@\n context\n-old\n+new\n+added"
  } });
  assert.match(plain(edited.render(80).join("\n")), /\+2 −1/u);
  const failed = new ToolExecutionComponent({ ...tool("failed"), status: "failed", exitCode: 2, output: "ERROR first\nERROR second\nERROR third\nERROR fourth" });
  assert.match(plain(failed.render(80).join("\n")), /exit 2/u);
  assert.match(plain(failed.render(80).join("\n")), /ERROR first/u);
  assert.doesNotMatch(plain(failed.render(80).join("\n")), /ERROR fourth/u);
  assert.ok(failed.render(80).length <= 5);
});

test("editor decoration keeps completion rows outside the input and native Tab semantics", async () => {
  const app = new BinyTui(ui(), "/unused");
  const editor = app["editor"];
  editor.focused = true;
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "model", description: "Select model" }], "/unused"));
  editor.handleInput("/");
  const deadline = Date.now() + 1000;
  while (!editor.isShowingAutocomplete()) {
    assert.ok(Date.now() < deadline, "slash completion did not appear");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const lines = editor.render(40);
  const bottom = lines.findIndex((line) => plain(line).startsWith("╰"));
  assert.ok(bottom > 0 && bottom < lines.length - 1, "completion follows the input frame");
  assert.match(plain(lines.slice(bottom + 1).join("\n")), /model/u);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
  assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
  editor.handleInput("\t");
  assert.equal(editor.getText().trim(), "/model");
  assert.equal(editor.isShowingAutocomplete(), false);
});
