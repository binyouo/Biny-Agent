import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// Read only the helper source; never import its owner/process/cleanup module graph.
const file = new URL("./helpers/memoryOwnerCleanup.ts", import.meta.url);
const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const names = ["collectTestRootDiagnostics", "runTestRootCleanup"];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node && ts.isFunctionDeclaration(node));
  return node.getText(ast);
});
const js = stripTypeScriptTypes(`function build() { ${declarations.join("\n")} return { ${names.join(",")} }; }`, { mode: "strip" });
const bundle: unknown = new Function("path", "Buffer", `${js}; return build();`)(path, Buffer);
assert.ok(typeof bundle === "object" && bundle !== null);
async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  assert.ok(bundle && typeof bundle === "object" && name in bundle);
  const fn: unknown = Reflect.get(bundle, name);
  assert.equal(typeof fn, "function");
  assert.ok(typeof fn === "function");
  return await Reflect.apply(fn, undefined, args);
}
const counts = { matched: 1, signalled: 1, stopped: 1 };
const root = "/synthetic/tmp/biny-emotion-session-test-Ab12";
const entry = (name: string, kind = "file") => ({ name, isSymbolicLink: () => kind === "symlink", isDirectory: () => kind === "directory" });
function fakeIO(tree: Record<string, ReturnType<typeof entry>[]>, links = new Set<string>()) {
  const opened: string[] = [];
  let reads = 0;
  let closes = 0;
  return {
    opened, get reads() { return reads; }, get closes() { return closes; }, temporaryDirectory: "/synthetic/tmp",
    realpath: async (value: string) => value,
    lstat: async (value: string) => ({ isSymbolicLink: () => links.has(value), isDirectory: () => true }),
    opendir: async (value: string) => {
      opened.push(value);
      const pending = [...(tree[value] ?? [])];
      return { read: async () => { reads += 1; return pending.shift() ?? null; }, close: async () => { closes += 1; } };
    }
  };
}

test("success does not inspect or report diagnostics", async () => {
  let cleaned = 0;
  await invoke("runTestRootCleanup", async () => { cleaned += 1; }, async () => { throw new Error("must not inspect"); }, undefined, () => { throw new Error("must not report"); });
  assert.equal(cleaned, 1);
});

test("cleanup-only preserves exact thrown identity including undefined and null", async () => {
  for (const failure of [new Error("synthetic cleanup"), undefined, null]) {
    let caught = false;
    try { await invoke("runTestRootCleanup", async () => { throw failure; }, async () => ({ available: false }), undefined, () => undefined); }
    catch (error) { caught = true; assert.strictEqual(error, failure); }
    assert.equal(caught, true);
  }
});

test("both failures retain tagged primary and exact cleanup objects", async () => {
  for (const primary of [new Error("synthetic primary"), undefined, null]) {
    const cleanup = new Error("synthetic cleanup");
    await assert.rejects(invoke("runTestRootCleanup", async () => { throw cleanup; }, async () => ({}), { present: true, error: primary }, () => undefined), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.strictEqual(error.errors[0], primary);
      assert.strictEqual(error.errors[1], cleanup);
      return true;
    });
  }
});

test("successful cleanup leaves primary-only propagation unchanged", async () => {
  const primary = new Error("synthetic primary");
  await assert.rejects((async () => {
    let captured: { present: true; error: unknown } | undefined;
    try { throw primary; }
    catch (error) { captured = { present: true, error }; throw error; }
    finally { await invoke("runTestRootCleanup", async () => undefined, async () => ({}), captured, () => undefined); }
  })(), error => error === primary);
});

test("diagnostic collection and reporter failures cannot mask cleanup", async () => {
  const cleanup = new Error("synthetic cleanup");
  for (const diagnose of [async () => { throw new Error("injected read failure"); }, async () => ({ available: true })]) {
    await assert.rejects(invoke("runTestRootCleanup", async () => { throw cleanup; }, diagnose, undefined, () => { throw new Error("injected log failure"); }), error => error === cleanup);
  }
});

test("bounded relative names, depth and no symlink traversal", async () => {
  const io = fakeIO({ [root]: [entry("agent", "directory"), entry("escape", "symlink")], [root + "/agent"]: [entry("nested", "directory"), entry("x".repeat(300))] });
  const result = await invoke("collectTestRootDiagnostics", root, counts, io);
  assert.deepEqual(result, { available: true, entries: [
    { name: "agent", kind: "directory" }, { name: "escape", kind: "symlink" },
    { name: "agent/nested", kind: "directory" }, { name: ("agent/" + "x".repeat(300)).slice(0, 120), kind: "file" }
  ], truncated: true, owners: counts });
  assert.deepEqual(io.opened, [root, root + "/agent"]);
  assert.equal(io.closes, 2);
});

test("entry count and output bytes are bounded", async () => {
  const io = fakeIO({ [root]: Array.from({ length: 100 }, (_, i) => entry(String(i))) });
  const result = await invoke("collectTestRootDiagnostics", root, counts, io);
  assert.ok(result && typeof result === "object" && "entries" in result && Array.isArray(result.entries));
  assert.equal(result.entries.length, 32);
  assert.equal(io.reads, 32);
  assert.equal(io.closes, 1);
  const output: string[] = [];
  const failure = new Error("synthetic cleanup");
  await assert.rejects(invoke("runTestRootCleanup", async () => { throw failure; }, async () => ({ names: "😀".repeat(8_000) }), undefined, (text: string) => output.push(text)), error => error === failure);
  assert.equal(output.length, 1);
  assert.ok(Buffer.byteLength(output[0]!, "utf8") <= 8_192);
  assert.match(output[0]!, /"truncated":true/u);
});

test("unvalidated or symlink roots never open directories", async () => {
  for (const value of ["/outside/biny-emotion-session-test-Ab12", "/synthetic/tmp/ordinary", root + "/nested", root]) {
    const io = fakeIO({}, value === root ? new Set([root]) : new Set());
    const result = await invoke("collectTestRootDiagnostics", value, counts, io);
    assert.deepEqual(result, { available: false, reason: "unvalidated synthetic root", owners: counts });
    assert.deepEqual(io.opened, []);
  }
});


test("a queued directory observed as a symlink is never opened", async () => {
  const io = fakeIO({ [root]: [entry("agent", "directory")] }, new Set([root + "/agent"]));
  await invoke("collectTestRootDiagnostics", root, counts, io);
  assert.deepEqual(io.opened, [root]);
  assert.equal(io.closes, 1);
});
