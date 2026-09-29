import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ProcessTerminal, visibleWidth } from "@earendil-works/pi-tui";
import { FooterComponent } from "../src/tui/components/chrome.js";
import { SelectDialog } from "../src/tui/components/dialogs.js";
import { TranscriptView } from "../src/tui/components/transcriptView.js";
import { renderCardLines } from "../src/tui/components/cards.js";
import { slashCommandsForSurface } from "../src/runtime/commandRegistry.js";
import { startTui } from "../src/tui/index.js";
import { Theme, setTheme } from "../src/tui/theme/theme.js";
import { darkTheme, lightTheme } from "../src/tui/theme/palettes.js";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "").replace(/\u001b_pi:c\u0007/gu, "");

test("footer stays within every terminal width, including a long context counter", () => {
  const footer = new FooterComponent({
    cwd: "/workspace/中文项目", sessionId: "session", modelLabel: "长模型名称",
    permissionMode: "read-only", contextUsedTokens: 999_000, contextMaxTokens: 1_000_000,
    contextSource: "estimated", cacheHitRate: 0.95, sessionCacheHitRate: 0.87
  });
  for (let width = 1; width <= 120; width += 1) {
    const lines = footer.render(width);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${plain(line)}`);
  }
});

test("selectors search names, values and descriptions without selecting on spaces", () => {
  const selected: string[] = [];
  const dialog = new SelectDialog({
    title: "Models", items: [
      { value: "alpha", label: "Alpha", description: "Local chat" },
      { value: "beta", label: "Beta", description: "Cloud reasoning" },
      { value: "gamma", label: "中文模型", description: "Cloud coding" }
    ], searchable: true, onSelect: (item) => selected.push(item.value), onCancel: () => undefined
  });
  dialog.handleInput("CLOUD coding");
  const filtered = plain(dialog.render(80).join("\n"));
  assert.match(filtered, /中文模型/u);
  assert.doesNotMatch(filtered, /Alpha|Beta/u);
  assert.deepEqual(selected, []);
  dialog.handleInput("\r");
  assert.deepEqual(selected, ["gamma"]);
  dialog.handleInput(" missing");
  assert.match(plain(dialog.render(80).join("\n")), /No matches/u);
  dialog.handleInput("\r");
  assert.deepEqual(selected, ["gamma"], "empty results cannot submit a stale selection");
});

test("nested foreground and background styles restore their enclosing colors", () => {
  const theme = new Theme(darkTheme, "truecolor");
  const outerFg = theme.fg("text", "").split("\u001b[39m")[0]!;
  assert.ok(theme.fg("text", `a${theme.fg("error", "b")}c`).includes(`${outerFg}c`));
  const outerBg = theme.bg("selectedBg", "").split("\u001b[49m")[0]!;
  assert.ok(theme.bg("selectedBg", `a${theme.bg("userMessageBg", "b")}c`).includes(`${outerBg}c`));
});

test("unknown theme names, including prototype keys, fall back safely", () => {
  for (const name of ["missing", "constructor", "toString", "__proto__"]) {
    assert.equal(setTheme(name).name, "dark");
  }
});

test("readable text and semantic status colors contrast with built-in surfaces", () => {
  for (const definition of [darkTheme, lightTheme]) {
    const theme = new Theme(definition, "truecolor");
    const page = definition.export!.pageBg as string;
    for (const token of ["text", "muted", "dim", "success", "warning", "error", "accent"] as const) {
      assert.ok(contrast(theme.color(token), page) >= 4.5, `${definition.name}: ${token}`);
    }
    for (const background of ["userMessageBg", "selectedBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const) {
      assert.ok(contrast(theme.color("text"), theme.color(background)) >= 4.5, `${definition.name}: ${background}`);
    }
  }
});

test("non-interactive launch fails before initializing the terminal or runtime", async () => {
  const start = mock.method(ProcessTerminal.prototype, "start", () => { throw new Error("terminal initialized"); });
  try {
    await assert.rejects(startTui("/unused"), /interactive terminal.*biny run/isu);
    assert.equal(start.mock.callCount(), 0);
  } finally {
    start.mock.restore();
  }
});

test("theme changes refresh already rendered transcript text", () => {
  setTheme("dark");
  const view = new TranscriptView();
  view.sync({ committed: [{ id: "notice", kind: "notification", content: "Saved", tone: "success" }], active: [] });
  const before = view.render(80).join("\n");
  const light = setTheme("light");
  view.invalidate();
  const after = view.render(80).join("\n");
  assert.notEqual(after, before);
  assert.ok(after.includes(light.fg("success", "• Saved")));
  setTheme("dark");
});

test("theme selection is discoverable in terminal commands only", () => {
  const command = slashCommandsForSurface("tui").find((entry) => entry.name === "/theme");
  assert.equal(command?.acceptsArgs, true);
  assert.equal(slashCommandsForSurface("desktop").some((entry) => entry.name === "/theme"), false);
});

test("command cards fit narrow columns and wide Chinese titles", () => {
  for (let width = 1; width <= 80; width += 1) {
    const lines = renderCardLines({
      id: "card", kind: "card", command: "/status", title: "当前运行状态",
      data: { sections: [{ rows: [{ label: "模型", value: "本地模型" }, { label: "详情", value: "value", detail: true }] }] }
    }, false, width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${plain(line)}`);
  }
});

function contrast(left: string, right: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
