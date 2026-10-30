/** Actual TerminalScreen effects with inert DOM/xterm/IPC boundaries, not native PTY coverage. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(path.join(process.env.BINY_TERMINAL_SOURCE_ROOT ?? process.cwd(), "src/desktop/renderer/src/components/TerminalView.tsx"), "utf8");
const screen = source.slice(source.indexOf("function TerminalScreen("));
const connectionStart = screen.indexOf("  useEffect(() => {");
const connectionEnd = screen.indexOf("\n  }, [projectId, slotId, restartToken", connectionStart);
const activationStart = screen.indexOf("  useEffect(() => {", connectionEnd);
const activationEnd = screen.indexOf("\n  }, [active]);", activationStart);
assert.ok(connectionStart >= 0 && connectionEnd > connectionStart && activationStart > connectionEnd && activationEnd > activationStart);
const compile = (start: number, end: number): string => stripTypeScriptTypes(`(function () {${screen.slice(start + "  useEffect(() => {".length, end)}\n})()`, { mode: "transform" });
const connection = compile(connectionStart, connectionEnd);
const activation = compile(activationStart, activationEnd);
interface Handle { terminalId: string; replay: string; sequence: number }
interface Dimensions { cols: number; rows: number }
function setup({ slotId = "default", restartToken = 0, active = true, width = 1000, height = 700 } = {}) {
  let resolve!: (handle: Handle & { kind: "script" }) => void;
  let reject!: (reason: Error) => void;
  const pending = new Promise<Handle & { kind: "script" }>((yes, no) => { resolve = yes; reject = no; });
  const sent: Array<Dimensions & { terminalId: string }> = [];
  const errors: unknown[] = [];
  const created: unknown[][] = [];
  const container = { clientWidth: width, clientHeight: height };
  const activeRef = { current: active };
  const fitRef = { current: undefined as unknown };
  let target = { cols: 120, rows: 40 };
  let observer!: () => void;
  let frame: (() => void) | undefined;
  let terminal!: FakeTerminal;
  class FakeTerminal {
    cols = 80; rows = 24; options: { theme?: unknown } = {};
    listener: ((size: Dimensions) => void) | undefined;
    constructor() { terminal = this; }
    loadAddon(addon: FakeFitAddon): void { addon.activate(this); }
    open(): void {} write(): void {} focus(): void {} dispose(): void {}
    onData(): { dispose(): void } { return { dispose() {} }; }
    onResize(listener: (size: Dimensions) => void): { dispose(): void } { this.listener = listener; return { dispose() {} }; }
    resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.listener?.({ cols, rows }); }
  }
  // FitAddon 0.11/xterm 6 fit() emits resize only when proposed dimensions change.
  // Layout measurement is inert; the unchanged-dimensions guard matches the library.
  class FakeFitAddon {
    terminal!: FakeTerminal;
    activate(value: FakeTerminal): void { this.terminal = value; }
    fit(): void { if (this.terminal.cols !== target.cols || this.terminal.rows !== target.rows) this.terminal.resize(target.cols, target.rows); }
  }
  const context = vm.createContext({
    Terminal: FakeTerminal, FitAddon: FakeFitAddon,
    containerRef: { current: container }, terminalRef: {}, fitRef, activeRef, handleRef: { current() {} },
    setError(value: unknown) { if (value !== undefined) errors.push(value); }, setExitCode() {},
    getComputedStyle() { return { getPropertyValue() { return ""; } }; }, readThemeColors() { return {}; },
    window: { matchMedia() { return { addEventListener() {}, removeEventListener() {} }; }, biny: {
      createTerminal(...args: unknown[]) { created.push(["create", ...args]); return pending; },
      startProjectPreview(...args: unknown[]) { created.push(["preview", ...args]); return pending; },
      resizeTerminal(terminalId: string, cols: number, rows: number) { sent.push({ terminalId, cols, rows }); },
      onTerminalEvent() { return () => {}; },
    } },
    document: { documentElement: {} },
    MutationObserver: class { observe(): void {} disconnect(): void {} },
    ResizeObserver: class { constructor(callback: () => void) { observer = callback; } observe(): void {} disconnect(): void {} },
    requestAnimationFrame(callback: () => void) { frame = callback; return 1; }, cancelAnimationFrame() { frame = undefined; },
    projectId: "project", slotId, restartToken, active,
    // #535's owner is an explicit boundary for the optional combination check.
    connectionOwner: { connect(callback: () => Promise<Handle>) { return callback(); } },
  }, { codeGeneration: { strings: false, wasm: false } });
  const cleanup = vm.runInContext(connection, context, { timeout: 1000 }) as () => void;
  const flush = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
  return {
    sent, errors, created, container, cleanup, observer: () => observer(), terminal: () => terminal,
    setTarget(cols: number, rows: number) { target = { cols, rows }; },
    setActive(value: boolean) { activeRef.current = value; context.active = value; },
    activate() { activeRef.current = true; context.active = true; vm.runInContext(activation, context, { timeout: 1000 }); frame?.(); },
    async connect(id = "pty") { resolve({ terminalId: id, replay: "", sequence: 0, kind: "script" }); await flush(); },
    async fail() { reject(new Error("connection failed")); await flush(); },
  };
}
const size = (terminalId = "pty", cols = 120, rows = 40) => ({ terminalId, cols, rows });

test("ordinary attachment synchronizes a viewport fitted before the IPC reply", async () => {
  const f = setup(); f.observer(); await f.connect();
  assert.deepEqual(f.sent, [size()]);
});
test("activation RAF fitting before connection also synchronizes on attachment", async () => {
  const f = setup(); f.activate(); await f.connect();
  assert.deepEqual(f.sent, [size()]);
});
test("connection before the first fit sends one resize, not duplicate messages", async () => {
  const f = setup(); await f.connect(); f.observer(); f.activate();
  assert.deepEqual(f.sent, [size()]);
});
test("preview restart synchronizes even when the viewport equals xterm's initial 80x24", async () => {
  const f = setup({ slotId: "preview", restartToken: 1 }); f.setTarget(80, 24); await f.connect("preview");
  assert.deepEqual(f.created, [["preview", "project"]]);
  assert.deepEqual(f.sent, [size("preview", 80, 24)]);
});
test("hidden attachment does not resize a persistent PTY until activated", async () => {
  const f = setup({ active: false }); f.observer(); await f.connect();
  assert.deepEqual(f.sent, []); f.activate(); assert.deepEqual(f.sent, [size()]);
});
test("fit then hide then connect then show still synchronizes unchanged dimensions", async () => {
  const f = setup(); f.observer(); f.setActive(false); await f.connect();
  assert.deepEqual(f.sent, []); f.activate(); assert.deepEqual(f.sent, [size()]);
});
test("unmeasurable attachment waits for a usable layout", async () => {
  const f = setup({ width: 0, height: 0 }); await f.connect(); assert.deepEqual(f.sent, []);
  f.container.clientWidth = 1000; f.container.clientHeight = 700; f.observer(); assert.deepEqual(f.sent, [size()]);
});
test("a later layout change is sent after initial synchronization and is never overwritten", async () => {
  const f = setup(); f.observer(); await f.connect(); f.setTarget(150, 50); f.observer(); f.activate();
  assert.deepEqual(f.sent, [size(), size("pty", 150, 50)]);
});
test("latest dimensions at settlement replace a preconnection layout", async () => {
  const f = setup(); f.observer(); f.setTarget(150, 50); f.observer(); await f.connect();
  assert.deepEqual(f.sent, [size("pty", 150, 50)]);
});
test("retired connection cannot resize after cleanup", async () => {
  const f = setup(); f.observer(); f.cleanup(); f.observer(); f.activate(); await f.connect("retired"); assert.deepEqual(f.sent, []);
});
test("a retired owner cannot resize the new screen's handle", async () => {
  const old = setup(); old.observer(); old.cleanup();
  const current = setup(); current.observer(); await current.connect("current"); await old.connect("retired");
  assert.deepEqual(old.sent, []); assert.deepEqual(current.sent, [size("current")]);
});
test("failed attachment has no handle to resize", async () => {
  const f = setup(); f.observer(); await f.fail(); assert.deepEqual(f.sent, []); assert.equal(f.errors.length, 1);
});

test("ordinary restart binds its own dimensions and handle", async () => {
  const f = setup({ slotId: "ordinary", restartToken: 2 }); f.observer(); await f.connect("replacement");
  assert.deepEqual(f.created, [["create", "project", 80, 24, "ordinary"]]);
  assert.deepEqual(f.sent, [size("replacement")]);
});
test("hiding pauses synchronization until activation with the latest layout", async () => {
  const f = setup(); await f.connect(); f.setActive(false); f.setTarget(150, 50); f.observer();
  assert.deepEqual(f.sent, [size()]); f.activate(); assert.deepEqual(f.sent, [size(), size("pty", 150, 50)]);
});
