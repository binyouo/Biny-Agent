import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Compile only the real addressing and routing functions. Never import the CLI,
// start a Host, download media or send a Telegram request.
async function extract(relative: string, names: readonly string[]): Promise<string> {
  const filename = path.join(process.cwd(), relative);
  const source = await readFile(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const nodes = tree.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  for (const name of names.filter(name => name !== "hasTelegramUsernameMention")) {
    assert.equal(nodes.filter(node => node.name?.text === name).length, 1, name);
  }
  const compiled = ts.transpileModule(nodes.map(node => node.getText(tree).replace(/^export /u, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  assert.doesNotMatch(compiled, /\b(?:require|import|fetch|process|globalThis|eval|Function|constructor)\b/u);
  return compiled;
}
const channelCode = await extract("src/channels/telegram.ts", [
  "shouldTelegramGroupMessageReachAgent", "hasTelegramUsernameMention", "telegramMessageText", "escapeRegExp", "parseTelegramId", "fileLabel"
]);
const routingCode = await extract("src/cli/commands/telegram.ts", ["processTelegramUpdate"]);
type Message = Record<string, unknown>;
type Gate = (message: Message, botId: number, username: string | undefined, allowed: ReadonlySet<string>) => boolean;
const gateSandbox: { gate?: Gate; path: Pick<typeof path, "basename"> } = { path: { basename: path.basename } };
vm.createContext(gateSandbox, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(channelCode + "\nthis.gate = shouldTelegramGroupMessageReachAgent;", gateSandbox, { timeout: 1_000 });
const gate = gateSandbox.gate!;
const base = { message_id: 1, date: 0, from: { id: 42 }, chat: { id: -100123, type: "supergroup" } };
const allowed = new Set(["-100123"]);
function check(name: string, fields: Message, expected: boolean, groups = allowed): void {
  test(name, () => assert.equal(gate({ ...base, ...fields }, 5, "biny_bot", groups), expected));
}
for (const text of ["@biny_bot hello", "(@biny_bot) hello", "请问，@biny_bot 帮我总结", "😀(@BiNy_BoT) hello", "  (@biny_bot) hello"]) {
  for (const field of ["text", "caption"]) {
    check(`${field}: ${text}`, { [field]: text, [field === "text" ? "entities" : "caption_entities"]:
      [{ type: "mention", offset: text.toLowerCase().indexOf("@biny_bot"), length: 9 }] }, true);
  }
}
check("legacy username remains case insensitive", { text: "@BiNy_BoT hello" }, true);
check("legacy whitespace remains supported", { text: "hello @biny_bot" }, true);
check("legacy punctuation behavior is unchanged", { text: "(@biny_bot) hello" }, false);
check("legacy longer usernames do not match", { text: "@biny_bot_other" }, false);
check("unauthorized group stays blocked", { text: "@biny_bot hello" }, false, new Set());
check("bot sender stays blocked", { text: "@biny_bot hello", from: { id: 99, is_bot: true } }, false);
check("missing sender stays blocked", { text: "@biny_bot hello", from: undefined }, false);
check("private message stays outside group routing", { text: "@biny_bot hello", chat: { id: -100123, type: "private" } }, false);
check("other mention stays blocked", { text: "@other_bot", entities: [{ type: "mention", offset: 0, length: 10 }] }, false);
check("longer username entity stays blocked", { text: "@biny_bot_other", entities: [{ type: "mention", offset: 0, length: 15 }] }, false);
check("empty entities are authoritative", { text: "@biny_bot hello", entities: [] }, false);
for (const type of ["pre", "code", "url", "text_mention"]) {
  check(`${type} is not a username mention`, { text: "@biny_bot hello", entities: [{ type, offset: 0, length: 9, user: { id: 5 } }] }, false);
}
const bounds: ReadonlyArray<readonly [unknown, unknown]> = [[-1, 9], [0, 0], [0, 999], [0, NaN], [NaN, 9], [0, 1.5], [Infinity, 9], [Number.MAX_SAFE_INTEGER, 9], [0, Number.MAX_SAFE_INTEGER], [1, 9], [0, 8], [0, "9"]];
for (const [offset, length] of bounds) {
  check(`invalid mention range ${String(offset)}/${String(length)}`, { text: "@biny_bot hello", entities: [{ type: "mention", offset, length }] }, false);
}
for (const entities of [null, {}, "mention", [null], [42]]) {
  check(`invalid metadata ${JSON.stringify(entities)}`, { text: "@biny_bot hello", entities }, false);
}
check("caption metadata cannot address different text", { text: "ordinary", caption: "@biny_bot", entities: [], caption_entities: [{ type: "mention", offset: 0, length: 9 }] }, false);
check("blank text still selects caption", { text: "  ", caption: "(@biny_bot)", caption_entities: [{ type: "mention", offset: 1, length: 9 }] }, true);
check("reply to bot remains supported", { text: "continue", entities: [], reply_to_message: { from: { id: 5 } } }, true);
check("reply to someone else stays blocked", { text: "continue", reply_to_message: { from: { id: 6 } } }, false);
check("a later matching entity is recognized", { text: "@other_bot (@biny_bot)", entities: [{ type: "mention", offset: 0, length: 10 }, { type: "mention", offset: 12, length: 9 }] }, true);

for (const owner of [true, false]) {
  for (const type of ["pre", "code", "mention"]) {
    test(`${owner ? "owner" : "member"} ${type}: real routing submits only addressed requests`, async () => {
      const calls: Array<{ kind: string; tools?: string }> = [];
      const text = type === "mention" ? "(@biny_bot) summarize" : "@biny_bot example";
      const message = { ...base, from: { id: owner ? 42 : 99 }, text, entities: [{ type, offset: type === "mention" ? 1 : 0, length: type === "mention" ? 9 : text.length }] };
      type Route = (updates: unknown[], bot: number, username: string, state: unknown, cache: unknown, options: unknown) => Promise<void>;
      const sandbox: { route?: Route; [key: string]: unknown } = {
        path: { basename: path.basename },
        appendGroupMessage: () => {},
        cacheUnaddressedGroupMedia: async () => { calls.push({ kind: "unaddressed" }); },
        prepareTelegramInput: async () => ({ input: text, attachments: [] }),
        ensureTelegramSession: async () => { calls.push({ kind: "session" }); return "fake-session"; },
        sendAgentReply: async () => { calls.push({ kind: "reply" }); }
      };
      vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(channelCode + routingCode + "\nthis.route = processTelegramUpdate;", sandbox, { timeout: 1_000 });
      await sandbox.route!([{ update_id: 1, message }], 5, "biny_bot", { groups: {}, sessions: {} }, {}, {
        ownerId: "42", allowedGroupIds: allowed, signal: new AbortController().signal, now: () => new Date(0), api: {},
        client: { submitPromptForSession: (_session: unknown, _input: unknown, _attachments: unknown, _ids: unknown, _context: unknown, capabilities?: { tools: string }) => {
          calls.push({ kind: "submit", tools: capabilities?.tools });
          return { completion: Promise.resolve({ status: "completed", output: "fake reply" }) };
        } }
      });
      if (type === "mention") {
        assert.deepEqual(calls, [{ kind: "session" }, { kind: "submit", tools: owner ? undefined : "none" }, { kind: "reply" }]);
      } else assert.deepEqual(calls, [{ kind: "unaddressed" }]);
    });
  }
}
