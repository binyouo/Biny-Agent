import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, truncate, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { projectSessionsDir } from "../src/config/paths.js";
import { ApplicationImportService } from "../src/imports/service.js";
import { readSessionEvents } from "../src/session/events.js";
import { applicationImportsCommand, registerApplicationImportCommands } from "../src/cli/commands/applicationImports.js";

const claude = (content: string) => `${JSON.stringify({ uuid: "source-user", type: "user", message: { role: "user", content } })}\n`;
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-application-import-")));
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  const stateRoot = path.join(root, "imports");
  await mkdir(homeDir);
  await mkdir(workspaceRoot);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  await mkdir(process.env.BINY_AGENT_DIR);
  let config = structuredClone(defaultConfig);
  let revision = 0;
  const configStore: AgentConfigStore = {
    load: async () => config, save: async (value) => { config = value; },
    loadVersioned: async () => ({ config, revision: String(revision) }),
    saveVersioned: async (value, expected) => { assert.equal(expected, String(revision)); config = value; return { config, revision: String(++revision) }; }
  };
  const options = { configStore, homeDir, stateRoot };
  const service = new ApplicationImportService(options);
  return {
    root, homeDir, workspaceRoot, stateRoot, service, configStore,
    config: () => config,
    reopen: () => new ApplicationImportService(options),
    async source(name: string, content: string) {
      const file = path.join(homeDir, ".claude", "projects", "fixture", `${name}.jsonl`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return file;
    },
    async close() {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  };
}

await test("local preview imports selected sessions and persists dedupe across concurrent services", async () => {
  const f = await fixture();
  try {
    const file = await f.source("first", claude("First imported text"));
    const untouched = await f.source("unselected", claude("Unselected text"));
    const preview = await f.service.preview("claude");
    assert.equal(preview.items.filter((item) => item.category === "sessions").length, 2);
    const item = preview.items.find((item) => item.detail.includes("first.jsonl"));
    assert.ok(item);
    const request = { previewId: preview.id, itemIds: [item.id], workspaceRoot: f.workspaceRoot };
    const results = await Promise.all([f.service.run(request), f.reopen().run(request)]);
    assert.deepEqual(results.flatMap((history) => history.results.map((result) => result.status)).sort(), ["imported", "skipped"]);
    const imported = results.flatMap((history) => history.results).find((result) => result.status === "imported");
    assert.ok(imported?.sessionId);
    const events = await readSessionEvents(path.join(projectSessionsDir(f.workspaceRoot), `${imported.sessionId}.jsonl`));
    assert.equal(events.find((event) => event.type === "user_message")?.content, "First imported text");
    assert.equal(await readFile(file, "utf8"), claude("First imported text"));
    assert.equal(await readFile(untouched, "utf8"), claude("Unselected text"));
    const snapshot = await f.reopen().snapshot();
    assert.equal(snapshot.history.length, 2);
    assert.equal(snapshot.sync.hasSelection, true);
    assert.equal(snapshot.sync.enabled, false);
    assert.equal((await stat(f.stateRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(f.stateRoot, "state.json"))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

await test("configuration import is selected, preserves existing choices and leaves MCP disabled", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.homeDir, ".claude.json"), JSON.stringify({ mcpServers: { imported: { command: "node", args: ["fixture.js"], env: { TOKEN: "private-source-value" } } } }));
    const preview = await f.service.preview("claude");
    assert.equal(preview.items.length, 1);
    assert.equal(JSON.stringify(preview).includes("private-source-value"), false);
    assert.equal(preview.items[0]?.category, "mcp");
    const before = f.config().defaultModel;
    const history = await f.service.run({ previewId: preview.id, itemIds: [preview.items[0]!.id], workspaceRoot: f.workspaceRoot });
    assert.equal(history.results[0]?.status, "imported");
    assert.equal(f.config().extensions.mcp.imported?.enabled, false);
    assert.equal(f.config().defaultModel, before);
    assert.equal(JSON.stringify(await f.service.snapshot()).includes("private-source-value"), false);
    assert.equal((await readFile(path.join(f.stateRoot, "state.json"), "utf8")).includes("private-source-value"), false);
  } finally { await f.close(); }
});

await test("Codex recursive rollout discovery uses the actual transfer pipeline", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.homeDir, ".codex", "sessions", "2035", "06", "12");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "rollout-fixture.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: "external-fixture" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex selected text" }] } })}\n`);
    await writeFile(path.join(directory, "unrelated.jsonl"), claude("Wrong format"));
    const preview = await f.service.preview("codex");
    assert.equal(preview.items.length, 1);
    const result = await f.service.run({ previewId: preview.id, itemIds: [preview.items[0]!.id], workspaceRoot: f.workspaceRoot });
    assert.equal(result.results[0]?.status, "imported");
    const events = await readSessionEvents(path.join(projectSessionsDir(f.workspaceRoot), `${result.results[0]!.sessionId}.jsonl`));
    assert.equal(events.find((event) => event.type === "user_message")?.content, "Codex selected text");
  } finally { await f.close(); }
});

await test("an unsupported configuration retains truthful skipped history on repeated import", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.homeDir, ".codex"));
    await writeFile(path.join(f.homeDir, ".codex", "config.toml"), 'model = "example"\n');
    await writeFile(path.join(f.homeDir, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "private-token" } }));
    const preview = await f.service.preview("codex");
    assert.ok(preview.items[0]);
    const request = { previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot };
    const first = await f.service.run(request);
    assert.equal(first.results[0]?.status, "skipped");
    const repeated = await f.reopen().run(request);
    assert.equal(repeated.results[0]?.status, "skipped");
    assert.doesNotMatch(repeated.results[0]?.detail ?? "", /已导入/u);
    assert.equal(f.config().providers["imported-codex"], undefined);
  } finally { await f.close(); }
});

await test("source edits after revalidation cannot replace the pinned bytes selected by the preview", async () => {
  const f = await fixture();
  try {
    const source = await f.source("pinned", claude("Previewed text"));
    await writeFile(path.join(f.homeDir, ".claude.json"), JSON.stringify({ mcpServers: { change_source: { command: "node", args: [] } } }));
    const originalSave = f.configStore.saveVersioned!.bind(f.configStore);
    f.configStore.saveVersioned = async (...args) => { const result = await originalSave(...args); await writeFile(source, claude("Later replacement")); return result; };
    const preview = await f.service.preview("claude");
    const mcp = preview.items.find((item) => item.category === "mcp");
    const session = preview.items.find((item) => item.category === "sessions");
    assert.ok(mcp && session);
    const history = await f.service.run({ previewId: preview.id, itemIds: [mcp.id, session.id], workspaceRoot: f.workspaceRoot });
    assert.equal(history.results[1]?.status, "imported");
    const events = await readSessionEvents(path.join(projectSessionsDir(f.workspaceRoot), `${history.results[1]!.sessionId}.jsonl`));
    assert.equal(events.find((event) => event.type === "user_message")?.content, "Previewed text");
    assert.equal(await readFile(source, "utf8"), claude("Later replacement"));
  } finally { await f.close(); }
});

await test("write-ahead receipt survives a process exit after configuration publication and forbids replay", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.homeDir, ".claude.json"), JSON.stringify({ mcpServers: { test: { command: "node", args: [] } } }));
    const preview = await f.service.preview("claude");
    assert.ok(preview.items[0]);
    const script = path.join(f.root, "crash.mjs");
    await writeFile(script, `import{ApplicationImportService}from${JSON.stringify(path.resolve("src/imports/service.ts"))};
import{defaultConfig}from${JSON.stringify(path.resolve("src/config/schema.ts"))};import{writeFile,readFile}from'node:fs/promises';
const store={load:async()=>defaultConfig,save:async()=>{},loadVersioned:async()=>({config:defaultConfig,revision:'fixture'}),saveVersioned:async(config)=>{await writeFile(${JSON.stringify(path.join(f.root, "published.json"))},JSON.stringify(config));const state=JSON.parse(await readFile(${JSON.stringify(path.join(f.stateRoot, "state.json"))},'utf8'));if(state.receipts[0]?.status!=='attempting')process.exit(78);process.exit(77)}};
const service=new ApplicationImportService({configStore:store,homeDir:${JSON.stringify(f.homeDir)},stateRoot:${JSON.stringify(f.stateRoot)}});await service.run(${JSON.stringify({ previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot })});`);
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), script], { timeout: 10_000 }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 77);
    assert.equal(JSON.parse(await readFile(path.join(f.root, "published.json"), "utf8")).extensions.mcp.test.enabled, false);
    const recovered = await f.reopen().snapshot();
    assert.equal(recovered.history[0]?.results[0]?.status, "unknown");
    let writes = 0;
    f.configStore.saveVersioned = async () => { writes++; throw new Error("private-secret-must-not-leak"); };
    const rerun = await f.reopen().run({ previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot });
    assert.equal(rerun.results[0]?.status, "unknown");
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(rerun).includes("private-secret"), false);
  } finally { await f.close(); }
});

await test("changing workspace cannot replay an unknown write to the same global configuration", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.homeDir, ".claude.json"), JSON.stringify({ mcpServers: { test: { command: "node", args: [] } } }));
    let writes = 0;
    f.configStore.saveVersioned = async () => { writes++; throw new Error("unknown publication"); };
    const preview = await f.service.preview("claude");
    assert.ok(preview.items[0]);
    const request = { previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot };
    assert.equal((await f.service.run(request)).results[0]?.status, "unknown");
    const otherWorkspace = path.join(f.root, "other-workspace");
    await mkdir(otherWorkspace);
    assert.equal((await f.reopen().run({ ...request, workspaceRoot: otherWorkspace })).results[0]?.status, "unknown");
    assert.equal(writes, 1, "both workspaces address the same global configuration authority");
  } finally { await f.close(); }
});

const chatConversation = (id: string, text: string) => ({ id, title: `Conversation ${id}`, current_node: "user", mapping: {
  user: { id: "user", parent: null, children: [], message: { id: `message-${id}`, author: { role: "user" }, content: { content_type: "text", parts: [text] } } }
} });
await test("ChatGPT preview, history and sync selections distinguish export file basenames", async () => {
  const f = await fixture();
  try {
    const files = [path.join(f.root, "first-export.json"), path.join(f.root, "second-export.json")];
    for (const [index, file] of files.entries()) {
      await writeFile(file, JSON.stringify(chatConversation(`export-${index}`, "Selected text")));
      const preview = await f.service.preview("chatgpt", file);
      assert.equal(preview.label, `ChatGPT · ${path.basename(file)}`);
      assert.ok(preview.items[0]);
      const request = { previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot };
      if (index === 0) assert.equal((await f.service.run(request)).label, preview.label);
      else await f.service.configureSyncSelection(request);
    }
    const snapshot = await f.reopen().snapshot();
    assert.deepEqual(snapshot.sync.selections?.map((selection) => selection.label), ["ChatGPT · first-export.json", "ChatGPT · second-export.json"]);
    assert.equal(snapshot.history[0]?.label, "ChatGPT · first-export.json");
    assert.equal(snapshot.sync.selections?.some((selection) => selection.label.includes(f.root)), false);
  } finally { await f.close(); }
});
await test("ChatGPT explicit selection and sync do not duplicate an unchanged conversation when another changes", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "conversations.json");
    await writeFile(file, JSON.stringify([chatConversation("first", "Original first"), chatConversation("second", "Original second")]));
    const preview = await f.service.preview("chatgpt", file);
    assert.equal(preview.items.length, 2);
    const first = preview.items.find((item) => item.label === "Conversation first");
    assert.ok(first);
    const imported = await f.service.run({ previewId: preview.id, itemIds: [first.id], workspaceRoot: f.workspaceRoot });
    assert.equal(imported.results[0]?.status, "imported");
    await f.service.setSyncEnabled(true);
    await writeFile(file, JSON.stringify([chatConversation("first", "Original first"), chatConversation("second", "Changed unselected second")]));
    const synced = await f.reopen().sync();
    assert.equal(synced.history[0]?.results[0]?.status, "skipped");
    assert.equal(synced.history[0]?.results[0]?.sessionId, imported.results[0]?.sessionId);
    assert.equal(synced.history[0]?.results.length, 1);
  } finally { await f.close(); }
});

await test("unknown saved sources and unsafe state roots do not follow links or scan fake application locations", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.service.snapshot();
    assert.deepEqual(snapshot.sources.map((source) => source.source), ["claude", "codex", "chatgpt"]);
    assert.equal(snapshot.sources.every((source) => source.detected === false), true);
    const target = path.join(f.root, "source.json");
    await writeFile(target, JSON.stringify(chatConversation("first", "Text")));
    const link = path.join(f.root, "linked.json");
    await symlink(target, link);
    const preview = await f.service.preview("chatgpt", link);
    assert.equal(preview.items.length, 0);
    assert.ok(preview.warnings.length);
    const linkedState = path.join(f.root, "linked-state");
    await symlink(f.stateRoot, linkedState);
    await assert.rejects(new ApplicationImportService({ configStore: f.configStore, homeDir: f.homeDir, stateRoot: linkedState }).snapshot(), /真实目录/u);
    const large = path.join(f.root, "large.json");
    await writeFile(large, ""); await truncate(large, 64 * 1024 * 1024 + 1);
    assert.equal((await f.service.preview("chatgpt", large)).items.length, 0);
  } finally { await f.close(); }
});

await test("source parent links are not followed", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, "exports");
    await mkdir(directory);
    await writeFile(path.join(directory, "conversations.json"), JSON.stringify(chatConversation("first", "Text")));
    const linked = path.join(f.root, "linked-parent");
    await symlink(directory, linked);
    const preview = await f.service.preview("chatgpt", path.join(linked, "conversations.json"));
    assert.equal(preview.items.length, 0, "source parent aliases must not bypass link refusal");
    assert.ok(preview.warnings.length);
  } finally { await f.close(); }
});

for (const phase of ["writeFile", "sync"] as const) {
  await test(`failed atomic state ${phase} removes its exclusive temporary file`, async () => {
    const f = await fixture();
    const originalOpen = fs.open;
    try {
      await f.service.snapshot();
      const before = await readFile(path.join(f.stateRoot, "state.json"), "utf8");
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (path.basename(String(args[0])).startsWith(".state-")) handle[phase] = async () => { throw new Error("simulated state publication failure"); };
        return handle;
      };
      await assert.rejects(f.service.snapshot(), /simulated state publication failure/u);
      fs.open = originalOpen;
      assert.equal((await readdir(f.stateRoot)).some((file) => file.startsWith(".state-")), false, "failed publication must clean its own temporary file");
      assert.equal(await readFile(path.join(f.stateRoot, "state.json"), "utf8"), before);
    } finally { fs.open = originalOpen; await f.close(); }
  });
}

await test("bounded preview does not expose more than 256 local items", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 257 }, (_, index) => f.source(`session-${String(index).padStart(3, "0")}`, claude("Text"))));
    const preview = await f.service.preview("claude");
    assert.equal(preview.items.length, 256);
    assert.ok(preview.warnings.some((warning) => warning.includes("上限")));
  } finally { await f.close(); }
});

await test("ChatGPT records without source IDs do not silently sync a changed array position", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.root, "no-ids.json");
    const { id: _ignored, ...first } = chatConversation("first", "First selected");
    await writeFile(file, JSON.stringify([first]));
    const preview = await f.service.preview("chatgpt", file);
    assert.ok(preview.items[0]);
    await f.service.run({ previewId: preview.id, itemIds: [preview.items[0].id], workspaceRoot: f.workspaceRoot });
    await f.service.setSyncEnabled(true);
    const { id: _otherIgnored, ...replacement } = chatConversation("replacement", "Different conversation");
    await writeFile(file, JSON.stringify([replacement]));
    const snapshot = await f.reopen().sync();
    assert.ok(snapshot.sync.lastError);
    assert.equal(snapshot.history.length, 1, "an unstable array position is not continuing selection authorization");
  } finally { await f.close(); }
});

await test("CLI preview and execution return the same persisted domain results in text and JSON", async () => {
  const f = await fixture();
  const previousLog = console.log;
  const lines: string[] = [];
  console.log = (value: unknown) => lines.push(String(value));
  try {
    await f.source("cli", claude("CLI imported text"));
    const options = { configStore: f.configStore, homeDir: f.homeDir, stateRoot: f.stateRoot };
    const preview = await applicationImportsCommand(f.workspaceRoot, "preview", { ...options, source: "claude", json: true });
    assert.ok("items" in preview);
    assert.equal(JSON.parse(lines.at(-1)!).id, preview.id);
    const history = await applicationImportsCommand(f.workspaceRoot, "run", { ...options, previewId: preview.id, itemIds: [preview.items[0]!.id], json: false });
    assert.ok("results" in history);
    assert.equal(history.results[0]?.status, "imported");
    assert.equal(lines.some((line) => line.includes("imported") && line.includes("cli")), true);
    assert.equal((await f.service.snapshot()).history[0]?.id, history.id);
    assert.equal((await readdir(f.stateRoot)).some((file) => file.startsWith("session-snapshot-")), false);
  } finally { console.log = previousLog; await f.close(); }
});

await test("registered Commander commands honor inherited JSON flags before and after the subcommand", async () => {
  const f = await fixture();
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  console.log = (line: unknown) => lines.push(String(line));
  try {
    const file = path.join(f.root, "cli-source.json");
    await writeFile(file, JSON.stringify(chatConversation("first", "Registered CLI text")));
    for (const args of [
      ["imports", "preview", "chatgpt", "--file", file, "--json"],
      ["imports", "--json", "preview", "chatgpt", "--file", file]
    ]) {
      const program = new Command();
      registerApplicationImportCommands(program, f.workspaceRoot);
      await program.parseAsync(args, { from: "user" });
      const preview = JSON.parse(lines.at(-1)!) as { id: string; items: Array<{ id: string }> };
      assert.equal(preview.items.length, 1);
      const run = new Command();
      registerApplicationImportCommands(run, f.workspaceRoot);
      await run.parseAsync(["imports", "run", preview.id, "--item", preview.items[0]!.id, "--json"], { from: "user" });
      assert.ok(["imported", "skipped"].includes(JSON.parse(lines.at(-1)!).results[0]?.status));
    }
  } finally { console.log = originalLog; process.exitCode = originalExitCode; await f.close(); }
});

await test("sync configuration replaces the selected range and can remove it without importing", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.setSyncEnabled(true), /先选择/u);
    const first = await f.source("first", claude("First"));
    const second = await f.source("second", claude("Second"));
    const preview = await f.service.preview("claude");
    const [one, two] = preview.items;
    assert.ok(one && two);
    await f.service.run({ previewId: preview.id, itemIds: [one.id, two.id], workspaceRoot: f.workspaceRoot });
    const before = (await f.service.snapshot()).history.length;
    const configured = await f.service.configureSyncSelection({ previewId: preview.id, itemIds: [two.id], workspaceRoot: f.workspaceRoot });
    assert.deepEqual(configured.sync.selections?.[0]?.itemIds, [two.id]);
    assert.equal(configured.history.length, before, "selection changes alone do not import");
    await f.service.setSyncEnabled(true);
    await writeFile(first, claude("Changed first"));
    await writeFile(second, claude("Changed second"));
    const synced = await f.reopen().sync();
    assert.deepEqual(synced.history[0]?.results.map((result) => result.id), [two.id]);
    await f.service.configureSyncSelection({ previewId: preview.id, itemIds: [], workspaceRoot: f.workspaceRoot });
    const snapshot = await f.reopen().snapshot();
    assert.equal(snapshot.sync.hasSelection, false);
    assert.equal(snapshot.sync.enabled, false);
  } finally { await f.close(); }
});

await test("a concurrent disable waits for the admitted sync batch and prevents later admission", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.homeDir, ".claude.json"), JSON.stringify({ mcpServers: {
      first: { command: "node", args: ["first.js"] }, second: { command: "node", args: ["second.js"] }
    } }));
    const preview = await f.service.preview("claude");
    assert.equal(preview.items.length, 2);
    await f.service.configureSyncSelection({ previewId: preview.id, itemIds: preview.items.map((item) => item.id), workspaceRoot: f.workspaceRoot });
    await f.service.setSyncEnabled(true);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    let writes = 0;
    const originalSave = f.configStore.saveVersioned!.bind(f.configStore);
    f.configStore.saveVersioned = async (...args) => {
      if (++writes === 1) { started(); await gate; }
      return await originalSave(...args);
    };
    const syncing = f.service.sync();
    await admitted;
    let disabled = false;
    const disabling = f.reopen().setSyncEnabled(false).then((snapshot) => { disabled = true; return snapshot; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disabled, false, "the setting write waits for the admitted batch");
    release();
    await syncing;
    assert.equal((await disabling).sync.enabled, false);
    assert.equal(writes, 2, "both already-admitted items finish before the setting applies");
    await f.reopen().sync();
    assert.equal(writes, 2, "no new synchronization starts after disable returns");
  } finally { await f.close(); }
});

await test("changed source refuses stale preview then imports a new session without changing the old one", async () => {
  const f = await fixture();
  try {
    const file = await f.source("first", claude("Original"));
    const preview = await f.service.preview("claude");
    assert.ok(preview.items.length, "source conversations must appear in the preview");
    const request = { previewId: preview.id, itemIds: [preview.items[0]!.id], workspaceRoot: f.workspaceRoot };
    const initial = await f.service.run(request);
    await writeFile(file, claude("Updated"));
    const stale = await f.service.run(request);
    assert.equal(stale.results[0]?.status, "failed");
    assert.match(stale.results[0]?.detail ?? "", /变化.*预览/u);
    const fresh = await f.service.preview("claude");
    const next = await f.service.run({ ...request, previewId: fresh.id, itemIds: [fresh.items[0]!.id] });
    assert.equal(next.results[0]?.status, "imported");
    assert.notEqual(initial.results[0]?.sessionId, next.results[0]?.sessionId);
    const originalEvents = await readSessionEvents(path.join(projectSessionsDir(f.workspaceRoot), `${initial.results[0]!.sessionId}.jsonl`));
    assert.equal(originalEvents.find((event) => event.type === "user_message")?.content, "Original");
  } finally { await f.close(); }
});

await test("sync after restart processes changed selected content only and keeps original sessions", async () => {
  const f = await fixture();
  try {
    const selected = await f.source("selected", claude("One"));
    const preview = await f.service.preview("claude");
    assert.ok(preview.items.length, "source conversations must appear in the preview");
    await f.service.run({ previewId: preview.id, itemIds: [preview.items[0]!.id], workspaceRoot: f.workspaceRoot });
    await f.service.setSyncEnabled(true);
    await f.source("new-unselected", claude("Never selected"));
    await writeFile(selected, claude("Two"));
    const synced = await f.reopen().sync();
    assert.equal(synced.history[0]?.results.length, 1);
    assert.equal(synced.history[0]?.results[0]?.status, "imported");
    assert.equal(synced.history[0]?.results[0]?.label.includes("selected"), true);
    const stable = await f.reopen().sync();
    assert.equal(stable.history[0]?.results[0]?.status, "skipped");
  } finally { await f.close(); }
});

await test("symlinked source is excluded and malformed item cannot block independent valid imports", async () => {
  const f = await fixture();
  try {
    const target = await f.source("good", claude("Good"));
    await f.source("broken", "not-json\n");
    await symlink(target, path.join(path.dirname(target), "linked.jsonl"));
    const preview = await f.service.preview("claude");
    assert.equal(preview.items.some((item) => item.detail.includes("linked.jsonl")), false);
    assert.ok(preview.warnings.length);
    const result = await f.service.run({ previewId: preview.id, itemIds: preview.items.map((item) => item.id), workspaceRoot: f.workspaceRoot });
    assert.equal(result.results.filter((item) => item.status === "imported").length, 1);
    assert.equal(result.results.filter((item) => item.status === "failed").length, 1);
    assert.equal(result.results.some((item) => item.status === "unknown"), false, "validation failures are proven before writing sessions");
  } finally { await f.close(); }
});
