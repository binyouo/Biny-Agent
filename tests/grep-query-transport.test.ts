import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the complete production module with a closed import allowlist. No
// ripgrep package, process, Host, provider or workspace runtime is imported.
const source = readFileSync(path.join(process.env.BINY_GREP_SOURCE_ROOT ?? process.cwd(), "src/tools/search/ripgrep.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Options {
  query: string;
  mode: "literal" | "regex";
  caseSensitive: boolean;
  workspaceRoot: string;
  files: string[];
  maxMatches: number;
  signal?: AbortSignal;
}
const options: Options = { query: "needle", mode: "literal", caseSensitive: true,
  workspaceRoot: "C:\\fixture", files: ["input.txt"], maxMatches: 2 };

class InertStream extends EventEmitter {
  setEncoding(encoding: string): this { assert.equal(encoding, "utf8"); return this; }
}
class InertChild extends EventEmitter {
  readonly stdout = new InertStream();
  readonly stderr = new InertStream();
  readonly stdin: InertStream & { end: (chunk?: string, encoding?: BufferEncoding) => void };
  input = Buffer.alloc(0);
  kills = 0;
  didClose = false;
  constructor(readonly file: string, readonly args: string[], readonly spawnOptions: unknown, onEnd?: (child: InertChild) => void) {
    super();
    this.stdin = Object.assign(new InertStream(), { end: (chunk?: string, encoding?: BufferEncoding) => {
      this.input = Buffer.from(chunk ?? "", encoding);
      onEnd?.(this);
    } });
  }
  kill(signal: string): boolean { assert.equal(signal, "SIGKILL"); this.kills += 1; return true; }
  close(code: number | null = 1): void { this.didClose = true; this.emit("close", code); }
}

function fixture(onEnd?: (child: InertChild) => void) {
  const children: InertChild[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const exports = {} as { searchRipgrepFiles: (args: Options) => Promise<Map<string, unknown>> };
  runInNewContext(compiled.outputText, {
    exports, Buffer, DOMException,
    process: { versions: {} },
    require: (id: string) => {
      if (id === "node:child_process") return { spawn: (file: string, args: string[], spawnOptions: unknown) => {
        const child = new InertChild(file, args, spawnOptions, onEnd);
        children.push(child);
        return child;
      } };
      if (id === "node:path") return { default: path.win32 };
      if (id === "@vscode/ripgrep") return { rgPath: "C:\\Biny\\rg.exe" };
      throw new Error(`Unexpected production dependency: ${id}`);
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 10_000);
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); }
  }, { timeout: 1000 });
  return { search: exports.searchRipgrepFiles, children, timers };
}

test("pattern transport keeps the full supported query out of Windows command lines", async () => {
  for (const [query, mode, caseSensitive] of [
    ["[a.*?]".repeat(10_000), "literal", true],
    ["😀".repeat(16_384), "literal", false],
    ["^(?:needle){1}$", "regex", true],
    ["needle\r", "literal", true],
    ["-n $(echo unwanted)", "literal", false],
    ["", "regex", true]
  ] as const) {
    const f = fixture(child => queueMicrotask(() => {
      // ASCII Windows executable/paths: this lower bound alone rejected the old
      // 60k argv before OS quoting. This is a simulated limit, not a Windows run.
      const commandCharacters = [child.file, ...child.args].join(" ").length + 1;
      if (commandCharacters > 32_767) child.emit("error", new Error("simulated Windows command-line limit"));
      child.close(commandCharacters > 32_767 ? null : 1);
    }));
    const result = await f.search({ ...options, query, mode, caseSensitive, files: ["input.txt", "-", "a b.txt"] });
    const child = f.children[0]!;
    assert.equal(result.size, 0);
    assert.deepEqual(child.input, Buffer.from(query || "\n", "utf8"));
    assert.ok(!child.args.includes(query), "query content must not be an argv operand");
    assert.ok(!child.args.includes("--regexp"));
    assert.equal(child.args[child.args.indexOf("--file") + 1], "-");
    assert.equal(child.args.includes("--fixed-strings"), mode === "literal");
    assert.ok(child.args.includes(caseSensitive ? "--case-sensitive" : "--ignore-case"));
    assert.ok(child.args.includes("--no-config"));
    assert.deepEqual(Array.from(child.args.slice(child.args.indexOf("--") + 1)), ["./input.txt", "./-", "./a b.txt"]);
    assert.deepEqual(JSON.parse(JSON.stringify(child.spawnOptions)), { cwd: options.workspaceRoot, env: {}, windowsHide: true });
    assert.equal(f.timers.size, 0);
  }
});

const controls = { skip: process.env.BINY_GREP_TRANSPORT_ONLY === "1" };
const brokenPipe = (): Error => Object.assign(new Error("broken pipe"), { code: "EPIPE" });

test("synchronous input failure retains process slots until close, then releases them", controls, async () => {
  const cause = new Error("synchronous write failed");
  const f = fixture(() => { throw cause; });
  let settled = 0;
  const pending = Array.from({ length: 8 }, () => f.search(options).then(
    () => assert.fail("input failure must reject"),
    error => { settled += 1; assert.equal(error.cause, cause); assert.match(error.message, /send the ripgrep query/u); }
  ));
  await Promise.resolve();
  assert.equal(settled, 0);
  assert.ok(f.children.every(child => child.kills === 1 && !child.didClose));
  assert.equal((await f.search({ ...options, files: [] })).size, 0, "empty search does not consume a slot");
  assert.equal(f.children.length, 8);
  await assert.rejects(f.search(options), /process limit/u);
  for (const child of f.children) child.close(null);
  await Promise.all(pending);
  assert.equal(settled, 8);
  assert.equal(f.timers.size, 0);
  const next = f.search(options);
  const rejected = assert.rejects(next, /send the ripgrep query/u);
  f.children.at(-1)!.close(null);
  await rejected;
  assert.equal(f.children.length, 9);
});

for (const code of [0, 1, 2]) {
  test(`asynchronous EPIPE with exit ${code} preserves failure and native diagnostics`, controls, async () => {
    const f = fixture();
    const cause = brokenPipe();
    const pending = f.search(options);
    const rejected = assert.rejects(pending, error => {
      const value = error as Error & { cause?: unknown };
      if (code === 2) assert.equal(value.message, "regex parse error: invalid fixture pattern");
      else { assert.match(value.message, /send the ripgrep query/u); assert.equal(value.cause, cause); }
      return true;
    });
    const child = f.children[0]!;
    child.stdin.emit("error", cause);
    assert.equal(child.kills, 0, "allow native diagnostics to arrive after stdin closes");
    if (code === 2) child.stderr.emit("data", "regex parse error: invalid fixture pattern\n");
    child.close(code);
    await rejected;
    assert.equal(f.timers.size, 0);
    const next = f.search(options);
    f.children[1]!.close();
    await next;
  });
}

for (const failure of ["startup", "abort", "timeout", "output"] as const) {
  test(`${failure} wins over stdin failure and waits for close`, controls, async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error("cancel this search");
    let settled = false;
    const pending = f.search({ ...options, signal: controller.signal });
    const rejected = assert.rejects(pending, error => {
      settled = true;
      if (failure === "abort") assert.equal(error, reason);
      else assert.match((error as Error).message, failure === "startup" ? /could not start/u : failure === "timeout" ? /timed out/u : /8 MiB/u);
      return true;
    });
    const child = f.children[0]!;
    child.stdin.emit("error", brokenPipe());
    if (failure === "startup") child.emit("error", new Error("ENOENT"));
    else if (failure === "abort") controller.abort(reason);
    else if (failure === "timeout") for (const callback of f.timers.values()) callback();
    else child.stdout.emit("data", "x".repeat(8 * 1024 * 1024 + 1));
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(child.kills, 1);
    child.close(null);
    await rejected;
    assert.equal(f.timers.size, 0);
    const kills = child.kills;
    controller.abort(reason);
    assert.equal(child.kills, kills, "abort listener is removed after close");
  });
}

test("empty and already-aborted searches never spawn", controls, async () => {
  const f = fixture();
  assert.equal((await f.search({ ...options, files: [] })).size, 0);
  const signal = AbortSignal.abort(new Error("already cancelled"));
  for (const files of [[], ["input.txt"]]) await assert.rejects(f.search({ ...options, files, signal }), error => error === signal.reason);
  assert.equal(f.children.length, 0);
  assert.equal(f.timers.size, 0);
});

test("close listener precedes input completion and output drains while stdin is pending", controls, async () => {
  const f = fixture(child => {
    assert.equal(child.listenerCount("close"), 1);
    child.stdout.emit("data", JSON.stringify({ type: "match", data: { path: { text: "./input.txt" },
      lines: { text: "😀 needle\n" }, line_number: 1, submatches: [{ start: 5 }] } }) + "\n");
    child.close(0);
  });
  const result = await f.search(options);
  assert.deepEqual(JSON.parse(JSON.stringify(result.get("input.txt"))), [{ line: 1, column: 4, text: "😀 needle" }]);
  assert.equal(f.timers.size, 0);
});
