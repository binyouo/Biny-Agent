/** Actual listing/resolver code with an inert filesystem model; no product filesystem is used. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import type { DesktopWorkspaceDirectory } from "../src/desktop/protocol.js";

function evaluate<T>(source: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const javascript = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText;
  vm.runInNewContext(javascript, { exports, Buffer, TextDecoder, require: (name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}
const sources = {
  service: readFileSync(new URL("../src/desktop/electron/main/DesktopProjectService.ts", import.meta.url), "utf8"),
  listing: readFileSync(new URL("../src/desktop/workspaceDirectoryListing.ts", import.meta.url), "utf8"),
  resolver: readFileSync(new URL("../src/workspace/resolvePath.ts", import.meta.url), "utf8"),
  credentials: readFileSync(new URL("../src/utils/secrets.ts", import.meta.url), "utf8"),
  ignore: readFileSync(new URL("../src/workspace/ignore.ts", import.meta.url), "utf8")
};
interface Node { type: "dir" | "file" | "link" | "fifo"; target?: string; dev: number; ino: number }
function fixture() {
  let serial = 0;
  const nodes = new Map<string, Node>();
  const calls: [string, string][] = [];
  let afterRead: () => void | Promise<void> = () => undefined;
  let afterStat: (name: string) => void | Promise<void> = () => undefined;
  const add = (name: string, type: Node["type"], target?: string): void => { nodes.set(name, { type, target, dev: 1, ino: ++serial }); };
  add("/", "dir"); add("/work", "dir"); add("/work/real", "dir"); add("/work/real/child.txt", "file");
  add("/outside", "dir"); add("/outside/private.txt", "file");
  const missing = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
  const resolve = (name: string, depth = 0): string => {
    if (depth > 40) throw Object.assign(new Error("link cycle"), { code: "ELOOP" });
    let result = "/";
    for (const part of path.posix.resolve(name).split("/").filter(Boolean)) {
      result = path.posix.join(result, part);
      const node = nodes.get(result);
      if (!node) throw missing();
      if (node.type === "link") result = resolve(node.target!, depth + 1);
    }
    return result;
  };
  const stat = (name: string) => {
    const node = nodes.get(name);
    if (!node) throw missing();
    return { ...node, size: 0, isDirectory: () => node.type === "dir", isFile: () => node.type === "file", isSymbolicLink: () => node.type === "link" };
  };
  const io = { lstatSync: stat, realpathSync: { native: resolve }, promises: {
    stat: async (name: string) => stat(resolve(name)),
    lstat: async (name: string) => { calls.push(["stat", name]); const snapshot = stat(name); await afterStat(name); return snapshot; },
    readdir: async (name: string) => {
      calls.push(["read", name]);
      const entries = [...nodes.keys()].filter(key => key !== name && path.posix.dirname(key) === name)
        .map(key => ({ ...stat(key), name: path.posix.basename(key) }));
      await afterRead();
      return entries;
    }
  } };
  const credentials = evaluate(sources.credentials, { "node:path": path.posix,
    "./redaction.js": { redactSecrets: () => { throw new Error("Unexpected redaction call"); } } });
  const ignore = evaluate(sources.ignore, { "../utils/secrets.js": credentials });
  const resolver = evaluate(sources.resolver, { "node:fs": io, "node:path": path.posix, "./ignore.js": ignore });
  const api = evaluate<{ readDesktopWorkspaceDirectory(root: string, requested: string): Promise<DesktopWorkspaceDirectory>; workspaceTreePath(root: string, requested: string): string }>(sources.listing,
    { "node:fs": io, "node:path": path.posix, "../workspace/ignore.js": ignore, "../workspace/resolvePath.js": resolver });
  const parsed = ts.createSourceFile("service.ts", sources.service, ts.ScriptTarget.Latest, true);
  const service = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopProjectService")!;
  const readMethod = service.members.find(node => node.name?.getText(parsed) === "readWorkspaceFile")!.getText(parsed);
  const preview = evaluate<{ preview(project: { path: string }, requested: string): Promise<{ path: string; content: string }> }>(
    `import { promises as fs } from "node:fs"; import path from "node:path";
     import { resolveWorkspacePath, toWorkspaceRelative } from "resolver"; import { workspaceTreePath } from "listing";
     const globalConfigDir = () => "/config"; const attachmentPathPrefix = "@attachments/"; const filePreviewLimit = 524288;
     class Service { workspaceFile(project, requested) { return resolveWorkspacePath(project.path, requested, [".git", "node_modules"]); }
     ${readMethod} }
     export const preview = (project, requested) => new Service().readWorkspaceFile(project, requested);`,
    { "node:fs": io, "node:path": path.posix, resolver, listing: api });
  return { add, nodes, calls, preview: (name: string) => preview.preview({ path: "/work" }, name), read: (name: string, root = "/work") => api.readDesktopWorkspaceDirectory(root, name),
    afterRead: (callback: typeof afterRead) => { afterRead = callback; }, afterStat: (callback: typeof afterStat) => { afterStat = callback; } };
}

test("internal directory aliases remain expandable under their requested tree addresses", async () => {
  const f = fixture(); f.add("/work/alias", "link", "/work/real");
  assert.equal((await f.read(".")).entries.find(entry => entry.name === "alias")?.kind, "directory");
  const listed = await f.read("alias");
  assert.equal(listed.path, "alias"); assert.equal(listed.entries[0]?.path, "alias/child.txt");
});

test("normal directories and regular-file links keep kind and directory-first order", async () => {
  const f = fixture(); f.add("/work/z.txt", "file"); f.add("/work/a.txt", "link", "/work/real/child.txt");
  assert.deepEqual(Array.from((await f.read(".")).entries, entry => [entry.name, entry.kind]), [["real", "directory"], ["a.txt", "file"], ["z.txt", "file"]]);
});

for (const [name, type, target] of [
  ["external", "link", "/outside"], ["blocked", "link", "/work/.git"], ["broken", "link", "/missing"],
  ["self", "link", "/work"], ["fifo", "fifo", undefined]
] as const) test(`${name} keeps its original non-expandable row`, async () => {
  const f = fixture(); f.add("/work/.git", "dir"); f.add(`/work/${name}`, type, target);
  const listed = await f.read(".");
  assert.equal(listed.entries.find(entry => entry.name === name)?.kind, "file");
  assert.equal(listed.entries.find(entry => entry.name === ".git")?.kind, "directory");
  assert.equal(f.calls.some(([, name]) => name.startsWith("/outside")), false);
});

test("cross-directory cycles keep non-expandable file rows and direct cyclic requests are rejected", async () => {
  const f = fixture(); f.add("/work/a", "dir"); f.add("/work/b", "dir");
  f.add("/work/a/to-b", "link", "/work/b"); f.add("/work/b/to-a", "link", "/work/a");
  assert.equal((await f.read("a/to-b")).entries.find(entry => entry.name === "to-a")?.kind, "file");
  await assert.rejects(f.read("a/to-b/to-a"), /cyclic/);
});

for (const target of ["/outside", "/work/other"]) test(`retarget during directory read rejects the stale listing: ${target}`, async () => {
  const f = fixture(); f.add("/work/other", "dir"); f.add("/work/alias", "link", "/work/real");
  f.afterRead(() => f.add("/work/alias", "link", target));
  await assert.rejects(f.read("alias"), /changed|escapes/);
});

test("same-path directory replacement cannot publish the previous inode's entries", async () => {
  const f = fixture(); f.afterRead(() => f.add("/work/real", "dir"));
  await assert.rejects(f.read("real"), /changed/);
});

test("child alias changed during classification is not made expandable", async () => {
  const f = fixture(); f.add("/work/alias", "link", "/work/real");
  f.afterStat(name => { if (name === "/work/real") f.add("/work/alias", "link", "/outside"); });
  assert.equal((await f.read(".")).entries.find(entry => entry.name === "alias")?.kind, "file");
});

test("existing traversal and ignored-directory authorization remains enforced", async () => {
  const f = fixture();
  await assert.rejects(f.read("../outside"), /escapes/);
  await assert.rejects(f.read(".git"), /ignored/);
  assert.equal(f.calls.length, 0);
});

test("symlinked project roots retain relative addresses", async () => {
  const f = fixture(); f.add("/project-alias", "link", "/work");
  assert.equal((await f.read("real", "/project-alias")).path, "real");
  await assert.rejects(f.read("/work/real", "/project-alias"), /escapes/, "canonical absolute paths outside the lexical project root stay rejected");
});

for (const protectedPath of [".env", ".env.production", "config.json", "config.json.backup", ".npmrc", ".ssh", ".aws"]) {
  test(`actual credential policy blocks direct names and innocent aliases: ${protectedPath}`, async () => {
    const f = fixture(); const kind = protectedPath === ".ssh" || protectedPath === ".aws" ? "dir" : "file";
    f.add(`/work/${protectedPath}`, kind); f.add("/work/innocent", "link", `/work/${protectedPath}`);
    const listed = await f.read(".");
    assert.equal(listed.entries.find(entry => entry.name === "innocent")?.kind, "file");
    assert.equal(listed.entries.find(entry => entry.name === protectedPath)?.kind, kind === "dir" ? "directory" : "file");
    await assert.rejects(f.read(protectedPath), /ignored/);
    await assert.rejects(f.read("innocent"), /ignored/);
    assert.equal(f.calls.some(([, name]) => name.includes(protectedPath)), false);
  });
}

test("actual file-preview method preserves alias selection and canonical authorization", async () => {
  const f = fixture(); f.add("/work/alias", "link", "/work/real");
  const listed = await f.read("alias");
  assert.equal((await f.preview(listed.entries[0]!.path)).path, "alias/child.txt");
  f.add("/work/alias", "link", "/outside");
  await assert.rejects(f.preview("alias/private.txt"), /escapes/);
});

test("actual inspector loader settles the alias request key instead of leaving its spinner", async () => {
  const f = fixture(); f.add("/work/alias", "link", "/work/real");
  const result = await f.read("alias");
  const source = readFileSync(new URL("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("inspector.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer = "";
  const find = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "loadDirectory") initializer = node.initializer!.getText(parsed);
    ts.forEachChild(node, find);
  };
  find(parsed); assert.ok(initializer);
  const helpers = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
    && (node.name?.text === "normalizeWorkspacePath" || node.name?.text === "errorMessage")).map(node => node.getText(parsed)).join("\n");
  const loader = evaluate<{ load(name: string): void; states(): Map<string, { status: string }> }>(`
    import { read } from "reader";
    const onListDirectory = read, useCallback = (callback) => callback;
    const directoryRequestRef = { current: new Map() }, directoryRequestIdRef = { current: 0 };
    let current = new Map(); const setDirectoryStates = (update) => { current = update(current); };
    ${helpers}
    export const load = ${initializer}; export const states = () => current;
  `, { reader: { read: async () => result } });
  loader.load("alias"); assert.equal(loader.states().get("alias")?.status, "loading");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loader.states().get("alias")?.status, "ready");
  assert.equal(loader.states().has("real"), false);
});

test("legal descendants of a config.json-named directory keep the original whole-path policy", async () => {
  const f = fixture(); f.add("/work/config.json", "dir"); f.add("/work/config.json/nested", "dir");
  f.add("/work/config.json/nested/data.txt", "file"); f.add("/work/config.json/alias", "link", "/work/real");
  assert.equal((await f.read("config.json/nested")).entries[0]?.path, "config.json/nested/data.txt");
  assert.equal((await f.read("config.json/alias")).entries[0]?.path, "config.json/alias/child.txt");
  await assert.rejects(f.read("config.json"), /ignored/);
});
