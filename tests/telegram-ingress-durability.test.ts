import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Extract only ingress orchestration and state serialization. Importing the CLI
// would initialize unrelated Runtime Host, provider and native dependencies.
interface Update { update_id: number; message: { message_id: number; date: number; from: { id: number }; chat: { id: number; type: "private" }; text?: string; caption?: string; media_group_id?: string; photo?: Array<{ file_id: string }> } }
interface State { version: 1; ownerId?: string; nextUpdateId?: number; sessions: Record<string, string>; groups: Record<string, unknown>; pendingUpdates?: Update[] }
interface Store { read(): Promise<State>; write(state: State): Promise<void>; path: string; workspaceRoot: string }
type Bridge = (options: Record<string, unknown>) => Promise<void>;
const commandPath = new URL("../src/cli/commands/telegram.ts", import.meta.url);
const channelPath = new URL("../src/channels/telegram.ts", import.meta.url);
const command = await fs.readFile(commandPath, "utf8");
const channel = await fs.readFile(channelPath, "utf8");

function extract(source: string, filename: string, select: (node: ts.Statement) => boolean): string {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  return tree.statements.filter(select).map(node => node.getText(tree).replace(/^export /u, "")).join("\n");
}
const functionNames = new Set(["runTelegramBridge", "collectTelegramMediaGroupUpdates", "groupTelegramMediaUpdates"]);
const ingress = extract(command, commandPath.pathname, node => ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text ?? ""));
const serialization = extract(channel, channelPath.pathname, node =>
  ts.isVariableStatement(node) && node.declarationList.declarations.every(declaration => ts.isIdentifier(declaration.name) && /Schema$/u.test(declaration.name.text))
  || ts.isClassDeclaration(node) && node.name?.text === "TelegramChannelStore"
  || ts.isFunctionDeclaration(node) && ["isNotFound", "emptyTelegramChannelState"].includes(node.name?.text ?? ""));

function load(handoff: (updates: Update[]) => Promise<void>): { bridge: Bridge; Store: new (root: string) => Store } {
  const sandbox = {
    fs, path, randomUUID, z,
    workspaceAgentDir: (root: string) => path.join(root, ".biny-test"),
    telegramMediaGroupDebounceMs: 800,
    processTelegramUpdate: handoff,
    patrolTelegramGroups: async () => {},
    waitBeforeRetry: async () => { throw new Error("unexpected polling retry"); },
    redactSecrets: (value: string) => value
  };
  vm.createContext(sandbox);
  const compiled = ts.transpileModule(serialization + "\n" + ingress, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  vm.runInContext(compiled + "\nthis.bridge = runTelegramBridge; this.Store = TelegramChannelStore;", sandbox);
  return sandbox as unknown as { bridge: Bridge; Store: new (root: string) => Store };
}

function update(id: number, album = false): Update {
  return { update_id: id, message: { message_id: id, date: 1800000000, from: { id: 42 }, chat: { id: 42, type: "private" },
    ...(album ? { media_group_id: "album-1", ...(id === 70 ? { caption: "Compare these photos" } : {}), photo: [{ file_id: `fake-${id}` }] }
      : { text: "Important preceding message" }) } };
}
const initialState = (): State => ({ version: 1, ownerId: "42", nextUpdateId: 69, sessions: {}, groups: {} });

async function fixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-telegram-ingress-inert-"));
  const handedOff: number[][] = [];
  const loaded = load(async updates => {
    handedOff.push(Array.from(updates, item => item.update_id));
    if (f.stopAfterHandoffs !== undefined && handedOff.length >= f.stopAfterHandoffs) f.controller.abort();
  });
  const store = new loaded.Store(directory);
  await store.write(initialState());
  const f: Fixture = {
    store, handedOff, offsets: [], queue: [update(69), update(70, true)], controller: new AbortController(),
    polls: 0, stopAfterHandoffs: undefined, afterAcknowledge: undefined,
    run: async () => {
      await loaded.bridge({
        ownerId: "42", allowedGroupIds: new Set(), signal: f.controller.signal, store: f.store,
        now: () => new Date("2026-10-22T03:00:00Z"),
        api: {
          getMe: async () => ({ id: 5, username: "fake_bot" }),
          getUpdates: async (offset: number | undefined) => {
            f.offsets.push(offset);
            f.queue = f.queue.filter(item => offset === undefined || item.update_id >= offset);
            f.polls++;
            f.afterAcknowledge?.(f.polls);
            // A bounded fixture guard, not a completion signal: failed recovery
            // still fails its handoff assertions after this guard stops the loop.
            if (f.polls > 8) f.controller.abort(new Error("fixture made no recovery progress"));
            return structuredClone(f.queue);
          },
          sendMessage: async () => { throw new Error("unexpected Telegram send"); }
        },
        client: {
          subscribeOwnerNotifications: async () => () => {},
          acknowledgeOwnerNotification: async () => { throw new Error("unexpected notification"); },
          ensureSession: async () => { throw new Error("unexpected Host access"); },
          submitPromptForSession: () => { throw new Error("unexpected Host access"); }
        }
      });
    },
    restart: () => { f.controller = new AbortController(); f.polls = 0; f.afterAcknowledge = undefined; }
  };
  try { await body(f); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
interface Fixture {
  store: Store; handedOff: number[][]; offsets: Array<number | undefined>; queue: Update[];
  controller: AbortController; polls: number; stopAfterHandoffs: number | undefined;
  afterAcknowledge: ((poll: number) => void) | undefined;
  run(): Promise<void>; restart(): void;
}

const tests: Array<[string, () => Promise<void>]> = [
  ["uninterrupted cross-poll collection remains one album handoff", () => fixture(async f => {
    f.afterAcknowledge = poll => { if (poll === 2) f.queue.push(update(71, true)); };
    f.stopAfterHandoffs = 2;
    await f.run();
    assert.deepEqual(f.handedOff, [[69], [70, 71]]);
    assert.deepEqual(f.offsets, [69, 71, 72]);
    assert.equal((await f.store.read()).nextUpdateId, 72);
  })],
  ["backward-compatible state and persisted pending payload round trip", () => fixture(async f => {
    const old = await f.store.read();
    assert.equal(old.nextUpdateId, 69);
    assert.deepEqual(old.pendingUpdates ?? [], []);
    const pending = [update(69), update(70, true), update(71, true)];
    await f.store.write({ ...old, pendingUpdates: pending });
    assert.deepEqual(JSON.parse(await fs.readFile(f.store.path, "utf8")).pendingUpdates, pending);
    assert.deepEqual(JSON.parse(JSON.stringify((await f.store.read()).pendingUpdates)), pending);
    await assert.rejects(f.store.write({ ...old, pendingUpdates: [update(-1)] }));
    assert.deepEqual(JSON.parse(JSON.stringify((await f.store.read()).pendingUpdates)), pending);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(f.store.path)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(f.store.path))).mode & 0o777, 0o700);
    }
  })],
  ["shutdown during album collection preserves every acknowledged batch", () => fixture(async f => {
    f.afterAcknowledge = poll => {
      if (poll === 2) f.queue.push(update(71, true));
      if (poll === 3) f.controller.abort(new Error("normal shutdown"));
    };
    await f.run();
    assert.deepEqual(f.offsets, [69, 71, 72]);
    assert.deepEqual(f.handedOff, []);
    assert.deepEqual(f.queue, []);
    f.restart();
    f.stopAfterHandoffs = 2;
    await f.run();
    assert.deepEqual(f.handedOff, [[69], [70, 71]], "acknowledged text and complete album must replay after shutdown");
    assert.deepEqual((await f.store.read()).pendingUpdates ?? [], []);
    assert.equal((await f.store.read()).nextUpdateId, 72);
  })],
  ["pending plus server redelivery does not duplicate album items", () => fixture(async f => {
    await f.store.write({ ...initialState(), pendingUpdates: [update(69), update(70, true)] });
    f.queue.push(update(71, true));
    f.stopAfterHandoffs = 2;
    await f.run();
    assert.deepEqual(f.handedOff, [[69], [70, 71]]);
    assert.deepEqual((await f.store.read()).pendingUpdates ?? [], []);
  })],
  ["interleaved groups retain unconsumed updates across a partial checkpoint", () => fixture(async f => {
    f.queue = [update(70, true), update(71), update(72, true)];
    f.stopAfterHandoffs = 1;
    await f.run();
    assert.deepEqual(f.handedOff, [[70]], "existing adjacent-only grouping is unchanged");
    assert.equal((await f.store.read()).nextUpdateId, 71);
    f.restart();
    f.stopAfterHandoffs = 3;
    await f.run();
    assert.deepEqual(f.handedOff, [[70], [71], [72]]);
    assert.equal((await f.store.read()).nextUpdateId, 73);
  })],
  ["failed staging write never advances server acknowledgement", () => fixture(async f => {
    const write = f.store.write.bind(f.store);
    let fail = true;
    f.store.write = async state => { if (fail) { fail = false; throw new Error("injected stage write failure"); } await write(state); };
    await assert.rejects(f.run(), /injected stage write failure/u);
    assert.deepEqual(f.offsets, [69], "look-ahead must not acknowledge an unstaged batch");
    assert.deepEqual(f.handedOff, []);
    assert.deepEqual(f.queue.map(item => item.update_id), [69, 70]);
  })],
  ["failed later staging preserves prior payload and leaves the new batch unacknowledged", () => fixture(async f => {
    f.afterAcknowledge = poll => { if (poll === 2) f.queue.push(update(71, true)); };
    const write = f.store.write.bind(f.store);
    let fail = true;
    f.store.write = async state => {
      if (fail && state.pendingUpdates?.some(item => item.update_id === 71)) {
        fail = false;
        throw new Error("injected later stage write failure");
      }
      await write(state);
    };
    f.stopAfterHandoffs = 2;
    await assert.rejects(f.run(), /injected later stage write failure/u);
    assert.deepEqual(f.offsets, [69, 71]);
    assert.deepEqual(f.handedOff, []);
    assert.deepEqual(f.queue.map(item => item.update_id), [71]);
    f.restart();
    await f.run();
    assert.deepEqual(f.handedOff, [[69], [70, 71]]);
  })],
  ["checkpoint failure leaves staged payload recoverable without exactly-once claims", () => fixture(async f => {
    f.queue.push(update(71, true));
    const write = f.store.write.bind(f.store);
    let fail = true;
    f.store.write = async state => {
      if (fail && state.nextUpdateId === 70) { fail = false; throw new Error("injected checkpoint failure"); }
      await write(state);
    };
    await assert.rejects(f.run(), /injected checkpoint failure/u);
    assert.deepEqual(f.handedOff, [[69]]);
    f.restart();
    // The first handoff may repeat because its checkpoint failed. This test
    // intentionally does not promise exactly-once processing or side effects.
    f.stopAfterHandoffs = 3;
    await f.run();
    assert.ok(f.handedOff.some(group => JSON.stringify(group) === "[70,71]"), "album must remain recoverable after earlier checkpoint failure");
    assert.equal((await f.store.read()).nextUpdateId, 72);
    assert.deepEqual((await f.store.read()).pendingUpdates ?? [], []);
  })]
];
let failures = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
assert.equal(failures, 0, `${failures} Telegram ingress durability regression(s) failed`);
