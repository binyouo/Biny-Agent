import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { Script, createContext } from "node:vm";

// Only this source read is real. The product is never imported. Every system,
// native, filesystem and attachment binding in the full wrapper is inert.
const source = readFileSync(new URL("../src/tui/runtime/clipboard.ts", import.meta.url), "utf8");
const imports = [
  'import { spawnSync } from "node:child_process";',
  'import { createRequire } from "node:module";',
  'import { readFileSync, unlinkSync } from "node:fs";',
  'import { randomUUID } from "node:crypto";',
  'import { tmpdir } from "node:os";',
  'import path from "node:path";',
  'import type { AgentAttachment } from "../../agent/AgentSession.js";',
  'import { saveAttachment } from "../../attachments/store.js";'
];
let wrapper = source;
for (const line of imports) {
  assert.equal(wrapper.split(line).length, 2, `exact import: ${line}`);
  wrapper = wrapper.replace(line, "");
}
assert.equal(wrapper.split("import.meta.url").length, 2);
wrapper = wrapper.replace("import.meta.url", '"fixture:clipboard"');
wrapper = wrapper.replace(/^export (?=(?:type|interface|function|async function)\b)/gmu, "");
assert.doesNotMatch(wrapper, /\b(?:import|export)\s/u, "no unreviewed module syntax");
const script = new Script(stripTypeScriptTypes(`${wrapper}\n({ pasteTuiClipboard, readClipboardImage, readClipboardText });`, { mode: "strip" }), { filename: "inert-tui-clipboard.js" });

type NativeMode = "absent" | "throw" | "false" | "true";
type TextMode = { value: string } | { error: true };
type ImageMode = { bytes: number[]; array?: true } | { error: true };
interface CommandStep { command: string; args: string[]; output?: string | number[]; status?: number; error?: true; timeout?: number; }
interface Scenario {
  name: string;
  platform?: "darwin" | "linux" | "win32";
  wayland?: true;
  native: NativeMode;
  text?: TextMode;
  image?: ImageMode;
  commands?: CommandStep[];
  expected: "empty" | { text: string } | { image: number[]; mime: string; suffix: string };
  trace: string[];
}
interface Product {
  pasteTuiClipboard(root: string): Promise<{ kind: string; text?: string; attachment?: Record<string, unknown> }>;
}
const syntheticText = "  synthetic 中文 👋\r\nline\n";
const pixels = [137, 80, 78, 71, 0, 255]; // Inert bytes, not an actual image.
const xclipArgs = ["-selection", "clipboard", "-o"];
const xclipImageArgs = (mime: string) => ["-selection", "clipboard", "-t", mime, "-o"];
const xclipEmpty: CommandStep[] = ["TARGETS", "image/png", "image/jpeg", "image/webp", "image/gif"].map(mime => ({ command: "xclip", args: xclipImageArgs(mime), status: 1, ...(mime === "TARGETS" ? { timeout: 1000 } : {}) }));
const xclipEmptyTrace = Array.from({ length: 5 }, () => "command:xclip");
const macText: CommandStep = { command: "pbpaste", args: [], output: syntheticText };
const scenarios: Scenario[] = [
  { name: "throwing probe continues to native text", native: "throw", text: { value: syntheticText }, expected: { text: syntheticText }, trace: ["require", "hasImage", "require", "getText"] },
  { name: "throwing probe and rejected text continue to command", native: "throw", text: { error: true }, commands: [macText], expected: { text: syntheticText }, trace: ["require", "hasImage", "require", "getText", "command:pbpaste"] },
  { name: "throwing probe preserves empty native text result", native: "throw", text: { value: "" }, expected: "empty", trace: ["require", "hasImage", "require", "getText"] },
  { name: "throwing probe with unavailable command is empty", native: "throw", text: { error: true }, commands: [{ command: "pbpaste", args: [], status: 1 }], expected: "empty", trace: ["require", "hasImage", "require", "getText", "command:pbpaste"] },
  { name: "Linux throwing probe continues to later Xclip image", platform: "linux", native: "throw", commands: [{ command: "xclip", args: xclipImageArgs("TARGETS"), output: "image/png\n", timeout: 1000 }, { command: "xclip", args: xclipImageArgs("image/png"), output: pixels }], expected: { image: pixels, mime: "image/png", suffix: "png" }, trace: ["read:/proc/version", "require", "hasImage", "command:xclip", "command:xclip", "save"] },
  { name: "Linux throwing probe continues through missing images to Xsel text", platform: "linux", native: "throw", text: { error: true }, commands: [...xclipEmpty, { command: "xclip", args: xclipArgs, status: 1 }, { command: "xsel", args: ["--clipboard", "--output"], output: syntheticText }], expected: { text: syntheticText }, trace: ["read:/proc/version", "require", "hasImage", ...xclipEmptyTrace, "require", "getText", "command:xclip", "command:xsel"] },
  { name: "Wayland modeled constructor failure does not block text command", platform: "linux", wayland: true, native: "throw", text: { error: true }, commands: [{ command: "wl-paste", args: ["--list-types"], output: "text/plain\n", timeout: 1000 }, ...xclipEmpty, ...xclipEmpty, { command: "wl-paste", args: ["--no-newline"], output: syntheticText }], expected: { text: syntheticText }, trace: ["read:/proc/version", "command:wl-paste", ...xclipEmptyTrace, "require", "hasImage", ...xclipEmptyTrace, "require", "getText", "command:wl-paste"] },
  { name: "false probe preserves native text", native: "false", text: { value: syntheticText }, expected: { text: syntheticText }, trace: ["require", "hasImage", "require", "getText"] },
  { name: "false probe preserves empty text without command fallback", native: "false", text: { value: "" }, expected: "empty", trace: ["require", "hasImage", "require", "getText"] },
  { name: "false probe and rejected native text preserve command", native: "false", text: { error: true }, commands: [macText], expected: { text: syntheticText }, trace: ["require", "hasImage", "require", "getText", "command:pbpaste"] },
  { name: "native image takes priority over text", native: "true", image: { bytes: pixels }, expected: { image: pixels, mime: "image/png", suffix: "png" }, trace: ["require", "hasImage", "getImageBinary", "save"] },
  { name: "native number array bytes preserved", native: "true", image: { bytes: pixels, array: true }, expected: { image: pixels, mime: "image/png", suffix: "png" }, trace: ["require", "hasImage", "getImageBinary", "save"] },
  { name: "rejected native image continues to text", native: "true", image: { error: true }, text: { value: syntheticText }, expected: { text: syntheticText }, trace: ["require", "hasImage", "getImageBinary", "require", "getText"] },
  { name: "zero length native image continues to text", native: "true", image: { bytes: [] }, text: { value: syntheticText }, expected: { text: syntheticText }, trace: ["require", "hasImage", "getImageBinary", "require", "getText"] },
  { name: "absent optional module preserves macOS fallback", native: "absent", commands: [macText], expected: { text: syntheticText }, trace: ["require", "require", "command:pbpaste"] },
  { name: "absent optional module with empty command stays empty", native: "absent", commands: [{ command: "pbpaste", args: [], output: "" }], expected: "empty", trace: ["require", "require", "command:pbpaste"] },
  { name: "absent optional module with command error stays empty", native: "absent", commands: [{ command: "pbpaste", args: [], error: true }], expected: "empty", trace: ["require", "require", "command:pbpaste"] },
  { name: "Windows command is unchanged and not executed", platform: "win32", native: "absent", commands: [{ command: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"], output: syntheticText }], expected: { text: syntheticText }, trace: ["require", "require", "command:powershell.exe"] },
  { name: "Wayland image wins before native module probing", platform: "linux", wayland: true, native: "throw", commands: [{ command: "wl-paste", args: ["--list-types"], output: "image/jpeg\ntext/plain\n", timeout: 1000 }, { command: "wl-paste", args: ["--type", "image/jpeg", "--no-newline"], output: pixels }], expected: { image: pixels, mime: "image/jpeg", suffix: "jpg" }, trace: ["read:/proc/version", "command:wl-paste", "command:wl-paste", "save"] },
  { name: "Linux native image wins before Xclip fallback", platform: "linux", native: "true", image: { bytes: pixels }, expected: { image: pixels, mime: "image/png", suffix: "png" }, trace: ["read:/proc/version", "require", "hasImage", "getImageBinary", "save"] }
];
assert.equal(scenarios.length, 20);
for (const scenario of scenarios) {
  test(`TUI native clipboard containment: ${scenario.name}`, async () => {
    const trace: string[] = [];
    const violations: string[] = [];
    const commands = [...(scenario.commands ?? [])];
    const fail = (name: string): never => { violations.push(name); throw new Error(`Unexpected fixture capability: ${name}`); };
    const native = {
      hasImage(): boolean {
        trace.push("hasImage");
        if (scenario.native === "throw") throw new Error("synthetic documented constructor failure");
        if (scenario.native === "absent") return fail("absent native probe");
        return scenario.native === "true";
      },
      async getText(): Promise<string> {
        trace.push("getText");
        if (!scenario.text) return fail("unplanned native text");
        if ("error" in scenario.text) throw new Error("synthetic native text unavailable");
        return scenario.text.value;
      },
      async getImageBinary(): Promise<number[] | Uint8Array> {
        trace.push("getImageBinary");
        if (!scenario.image) return fail("unplanned native image");
        if ("error" in scenario.image) throw new Error("synthetic native image unavailable");
        return scenario.image.array ? [...scenario.image.bytes] : Uint8Array.from(scenario.image.bytes);
      }
    };
    const context = createContext({
      Buffer, Uint8Array,
      process: Object.freeze({ platform: scenario.platform ?? "darwin", env: Object.freeze(scenario.platform === "linux" ? scenario.wayland ? { WAYLAND_DISPLAY: "fixture-wayland" } : { DISPLAY: ":fixture" } : {}) }),
      Date: Object.freeze({ now: () => 1234 }),
      createRequire: (url: string) => {
        assert.equal(url, "fixture:clipboard");
        return (name: string) => {
          trace.push("require");
          if (name !== "@mariozechner/clipboard") return fail(`module:${name}`);
          if (scenario.native === "absent") throw new Error("synthetic optional module missing");
          return native;
        };
      },
      spawnSync: (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
        trace.push(`command:${command}`);
        const step = commands.shift();
        if (!step) return fail(`unplanned command:${command}`);
        assert.equal(command, step.command);
        assert.deepEqual(Array.from(args), step.args);
        assert.equal(options.timeout, step.timeout ?? 3000);
        assert.equal(options.maxBuffer, 50 * 1024 * 1024);
        return { status: step.status ?? 0, stdout: typeof step.output === "string" ? Buffer.from(step.output) : Buffer.from(step.output ?? []), ...(step.error ? { error: new Error("synthetic spawn error") } : {}) };
      },
      readFileSync: (file: string, encoding: string) => {
        trace.push(`read:${file}`);
        if (scenario.platform !== "linux" || file !== "/proc/version" || encoding !== "utf8") return fail(`file:${file}`);
        return "Linux synthetic fixture kernel";
      },
      unlinkSync: () => fail("unlink"), randomUUID: () => fail("randomUUID"), tmpdir: () => fail("tmpdir"), path: Object.freeze({ join: () => fail("path.join") }),
      saveAttachment: async (root: string, name: string, mimeType: string, bytes: Uint8Array) => {
        trace.push("save");
        if (typeof scenario.expected !== "object" || !("image" in scenario.expected)) return fail("unplanned attachment save");
        assert.equal(root, "fixture:workspace");
        assert.equal(name, `biny-clipboard-1234.${scenario.expected.suffix}`);
        assert.equal(mimeType, scenario.expected.mime);
        assert.deepEqual(Array.from(bytes), scenario.expected.image);
        return { name, mimeType, path: "fixture:attachment" };
      }
    }, { codeGeneration: { strings: false, wasm: false } });
    const product = script.runInContext(context, { timeout: 1000 }) as Product;
    try {
      const result = await product.pasteTuiClipboard("fixture:workspace");
      if (scenario.expected === "empty") {
        assert.equal(result.kind, "empty");
        assert.equal(Object.keys(result).length, 1);
      } else if ("text" in scenario.expected) {
        assert.equal(result.kind, "text");
        assert.equal(result.text, scenario.expected.text);
        assert.equal(Object.keys(result).length, 2);
      } else {
        assert.equal(result.kind, "image");
        assert.equal(result.attachment?.data, Buffer.from(scenario.expected.image).toString("base64"));
        assert.equal(result.attachment?.mimeType, scenario.expected.mime);
        assert.equal(result.attachment?.name, `biny-clipboard-1234.${scenario.expected.suffix}`);
        assert.equal(result.attachment?.path, "fixture:attachment");
      }
      assert.deepEqual(trace, scenario.trace);
      assert.equal(commands.length, 0, "all prescribed commands consumed");
    } finally {
      assert.deepEqual(violations, [], "even caught forbidden capabilities fail the fixture");
    }
  });
}
