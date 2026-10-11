import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read source as text only. Evaluate the exact queue declarations with inert
// realpath/list/write callbacks. No product imports, Host, Recorder, SQLite,
// SDK, worker, process, or real catalog filesystem operations run here.
const source = ts.createSourceFile("catalog.ts",
  readFileSync(new URL("../src/session/catalog.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set([
  "indexRefreshes", "pendingIndexRefreshes", "refreshSessionIndex",
  "refreshSessionIndexInBackground", "drainSessionIndexRefreshes"
]);
const selected = source.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name !== undefined && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(
    declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text)
  );
});
for (const node of selected) {
  if (ts.isVariableStatement(node)) assert.equal(node.declarationList.declarations.length, 1);
}
const code = selected.map(node => node.getText(source).replace(/^export\s+/u, "")).join("\n")
  + "\n({ refresh: refreshSessionIndex, drain: typeof drainSessionIndexRefreshes === 'function' ? drainSessionIndexRefreshes : undefined, cleanup: CLEANUP });";
const hasDrain = selected.some(node => ts.isFunctionDeclaration(node) && node.name?.text === "drainSessionIndexRefreshes");
const lifecycleSource = ts.createSourceFile("lifecycle.ts",
  readFileSync(new URL("./desktop-session-read-lifecycle.test.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const cleanups: ts.ArrowFunction[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(lifecycleSource) === "context.after") {
    const callback = node.arguments[0];
    assert.ok(callback && ts.isArrowFunction(callback));
    cleanups.push(callback);
  }
  ts.forEachChild(node, visit);
}
visit(lifecycleSource);
assert.equal(cleanups.length, 1, "extract the actual lifecycle teardown, never a substitute");

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface Api {
  refresh(root: string): Promise<void>;
  drain?: () => Promise<void>;
  cleanup(): Promise<void>;
}

function fixture(options: {
  realpath?: (root: string) => Promise<string>;
  write?: (root: string) => Promise<void>;
} = {}) {
  const writes: string[] = [];
  let removals = 0;
  const fakeProcess = { env: { BINY_AGENT_DIR: "fixture" } };
  const api = runInNewContext(stripTypeScriptTypes(code.replace("CLEANUP", cleanups[0]!.getText(lifecycleSource)), { mode: "strip" }), {
    path,
    context: { mock: { restoreAll() {} } },
    manager: { closeAll: async () => {} },
    process: fakeProcess,
    previousAgentDir: "previous",
    root: "/fixture",
    rm: async () => { removals++; },
    fs: { realpath: options.realpath ?? (async (root: string) => root) },
    listSessionCatalog: async () => [],
    writeSessionIndexFile: async (root: string) => {
      writes.push(root);
      await options.write?.(root);
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
  const drain = () => {
    assert.equal(typeof api.drain, "function", "source must expose a complete-admission drain");
    return api.drain!();
  };
  return { ...api, drain, writes, removals: () => removals, environment: () => fakeProcess.env.BINY_AGENT_DIR };
}

test("actual lifecycle teardown cannot delete or restore environment before a blocked refresh completes", { timeout: 2_000 }, async () => {
  const blocked = gate();
  const entered = gate();
  const f = fixture({ realpath: async root => {
    if (root === "/old") { entered.resolve(); await blocked.promise; }
    return root;
  } });
  const earlier = f.refresh("/old");
  await entered.promise;
  const cleanup = f.cleanup();
  try {
    // A later refresh overtakes old realpath admission. It is not itself a drain.
    await f.refresh("/independent");
    assert.equal(f.removals(), 0, "the actual cleanup must not reach rm while an admitted index refresh is blocked");
    assert.equal(f.environment(), "fixture");
  } finally {
    blocked.resolve();
    await Promise.all([earlier, cleanup]);
  }
  assert.equal(f.removals(), 1);
  assert.equal(f.environment(), "previous");
});

test("drain includes old realpath admission after a later refresh overtakes it", { skip: !hasDrain, timeout: 2_000 }, async () => {
  const old = gate();
  const entered = gate();
  let first = true;
  const f = fixture({ realpath: async root => {
    if (first) { first = false; entered.resolve(); await old.promise; }
    return root;
  } });
  const earlier = f.refresh("/workspace");
  await entered.promise;
  let drained = false;
  const draining = f.drain().then(() => { drained = true; });
  try {
    await f.refresh("/workspace");
    assert.equal(drained, false, "later refresh cannot stand in for the blocked admission");
    assert.equal(f.writes.length, 1);
  } finally {
    old.resolve();
    await Promise.all([earlier, draining]);
    await f.drain();
  }
  assert.equal(f.writes.length, 2);
  await f.drain();
});

test("canonical aliases coalesce and preserve the dirty follow-up publication", { skip: !hasDrain, timeout: 2_000 }, async () => {
  const firstWrite = gate();
  const secondWrite = gate();
  const releaseFirst = gate();
  const releaseSecond = gate();
  const aliasResolved = gate();
  let count = 0;
  const f = fixture({
    realpath: async root => {
      if (root === "/alias") aliasResolved.resolve();
      return "/canonical";
    },
    write: async () => {
      count++;
      if (count === 1) { firstWrite.resolve(); await releaseFirst.promise; }
      if (count === 2) { secondWrite.resolve(); await releaseSecond.promise; }
    }
  });
  const first = f.refresh("/canonical");
  await firstWrite.promise;
  const alias = f.refresh("/alias");
  await aliasResolved.promise;
  let drained = false;
  const draining = f.drain().then(() => { drained = true; });
  try {
    releaseFirst.resolve();
    await secondWrite.promise;
    assert.equal(drained, false);
    assert.equal(count, 2, "alias must request a follow-up round on the same canonical queue");
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all([first, alias, draining]);
    await f.drain();
  }
  assert.deepEqual(f.writes, ["/canonical", "/canonical"]);
});

test("drain includes another workspace admitted while it is waiting", { skip: !hasDrain, timeout: 2_000 }, async () => {
  const aEntered = gate();
  const bEntered = gate();
  const aRelease = gate();
  const bRelease = gate();
  const f = fixture({ write: async root => {
    if (root === "/a") { aEntered.resolve(); await aRelease.promise; }
    if (root === "/b") { bEntered.resolve(); await bRelease.promise; }
  } });
  const a = f.refresh("/a");
  await aEntered.promise;
  let drained = false;
  const draining = f.drain().then(() => { drained = true; });
  const b = f.refresh("/b");
  await bEntered.promise;
  try {
    aRelease.resolve();
    await a;
    await f.refresh("/independent");
    assert.equal(drained, false, "a later admitted workspace remains part of cleanup");
  } finally {
    aRelease.resolve();
    bRelease.resolve();
    await Promise.all([a, b, draining]);
    await f.drain();
  }
  assert.deepEqual(f.writes, ["/a", "/b", "/independent"]);
});

for (const failure of ["realpath", "write"] as const) {
  test(`failed ${failure} releases admission and permits a later refresh`, { skip: !hasDrain, timeout: 2_000 }, async () => {
    let fail = true;
    const f = fixture({
      realpath: async root => {
        if (failure === "realpath" && fail) { fail = false; throw new Error("inert realpath failure"); }
        return root;
      },
      write: async () => {
        if (failure === "write" && fail) { fail = false; throw new Error("inert write failure"); }
      }
    });
    await f.refresh("/workspace");
    await f.drain();
    const before = f.writes.length;
    await f.refresh("/workspace");
    await f.drain();
    assert.equal(f.writes.length, before + 1);
  });
}

test("empty drain is inert and does not prevent subsequent refreshes", { skip: !hasDrain, timeout: 2_000 }, async () => {
  const f = fixture();
  await f.drain();
  assert.deepEqual(f.writes, []);
  await f.refresh("/workspace");
  await f.drain();
  await f.drain();
  assert.deepEqual(f.writes, ["/workspace"]);
});
