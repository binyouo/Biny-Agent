import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// Read and extract only the real reply function. Never import the CLI or create
// TelegramBotApi: photo/message methods below only record in-memory calls.
const filename = path.join(process.cwd(), "src/cli/commands/telegram.ts");
const source = await readFile(filename, "utf8");
const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const functions = tree.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "sendAgentReply");
assert.equal(functions.length, 1);
const selected = functions[0]!;
const allowedCalls = new Set([
  "output.matchAll", "imagePaths.push", "output.replaceAll",
  'output.replaceAll(imagePattern, "").trim', "imagePaths.entries",
  "api.sendMessage", "api.sendPhoto", "api.sendOwnerSelfiePhoto"
]);
function inspect(node: ts.Node): void {
  assert.equal(ts.isNewExpression(node), false, "reply must not construct dependencies");
  if (ts.isCallExpression(node)) {
    assert.ok(allowedCalls.has(node.expression.getText(tree)), `unexpected reply call: ${node.expression.getText(tree)}`);
  }
  ts.forEachChild(node, inspect);
}
inspect(selected);
const compiled = ts.transpileModule(selected.getText(tree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
assert.doesNotMatch(compiled, /\b(?:import|require|process|fetch|eval|Function|globalThis|constructor)\b/u,
  "extracted reply must not load product dependencies or ambient capabilities");
interface Api {
  sendPhoto(chatId: number, filePath: string, caption?: string, signal?: AbortSignal, threadId?: number): Promise<void>;
  sendOwnerSelfiePhoto(ownerId: number, chatId: number, filePath: string, caption?: string, signal?: AbortSignal): Promise<void>;
  sendMessage(chatId: number, text: string, signal?: AbortSignal, threadId?: number): Promise<void>;
}
type Reply = (api: Api, chatId: number, output: string, signal: AbortSignal, ownerId?: number, threadId?: number) => Promise<void>;
const sandbox: { reply?: Reply } = {};
vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(compiled + "\nthis.reply = sendAgentReply;", sandbox, { timeout: 1_000 });
const reply = sandbox.reply!;
interface Photo { path: string; caption: string | undefined }
const images = "![first](<first image.png>)\n![second](second.png)";
const oneImage = "![first](<first image.png>)";
const shortText = "这两张照片说明同一件事 😀";

for (const owner of [false, true]) {
  const route = owner ? "owner" : "regular";
  function fixture(photoResult: (index: number) => Promise<void> = async () => {}, messageError?: Error) {
    const signal = new AbortController().signal;
    const chatId = owner ? 42 : -100123;
    const threadId = 77;
    const attempted: Photo[] = [];
    const delivered: Photo[] = [];
    const messages: string[] = [];
    const photo = async (id: number, filePath: string, caption: string | undefined, passedSignal: AbortSignal | undefined) => {
      assert.equal(id, chatId);
      assert.equal(passedSignal, signal);
      const entry = { path: filePath, caption };
      attempted.push(entry);
      await photoResult(attempted.length - 1);
      delivered.push(entry);
    };
    const api: Api = {
      sendPhoto: async (id, filePath, caption, passedSignal, passedThread) => {
        assert.equal(owner, false);
        assert.equal(passedThread, threadId);
        await photo(id, filePath, caption, passedSignal);
      },
      sendOwnerSelfiePhoto: async (ownerId, id, filePath, caption, passedSignal) => {
        assert.equal(owner, true);
        assert.equal(ownerId, 42);
        await photo(id, filePath, caption, passedSignal);
      },
      sendMessage: async (id, text, passedSignal, passedThread) => {
        assert.equal(id, chatId);
        assert.equal(passedSignal, signal);
        assert.equal(passedThread, threadId);
        messages.push(text);
        if (messageError) throw messageError;
      }
    };
    return { attempted, delivered, messages, run: (output: string) => reply(api, chatId, output, signal, owner ? 42 : undefined, threadId) };
  }
  // The runner also needs an outer process watchdog: VM initialization timeout
  // does not bound asynchronous calls after the function has been extracted.
  const add = (name: string, body: () => Promise<void>) => test(`${route}: ${name}`, { timeout: 5_000 }, body);
  // Model a definite pre-upload local rejection, not uncertain network delivery.
  const rejectFirst = async (index: number) => { if (index === 0) throw new Error("local image rejected before upload"); };
  const rejectAll = async () => { throw new Error("local image rejected before upload"); };

  add("first local rejection then successful photo preserves text", async () => {
    const f = fixture(rejectFirst);
    await f.run(`${shortText}\n${images}`);
    assert.deepEqual(f.attempted, [{ path: "first image.png", caption: shortText }, { path: "second.png", caption: undefined }]);
    assert.deepEqual(f.delivered, [{ path: "second.png", caption: undefined }]);
    assert.deepEqual(f.messages, [shortText]);
  });
  add("first caption success then failure does not repeat text", async () => {
    const f = fixture(async index => { if (index === 1) throw new Error("local rejection"); });
    await f.run(`${shortText}\n${images}`);
    assert.deepEqual(f.delivered, [{ path: "first image.png", caption: shortText }]);
    assert.deepEqual(f.messages, []);
  });
  add("all photos rejected preserve text", async () => {
    const f = fixture(rejectAll);
    await f.run(`${shortText}\n${images}`);
    assert.equal(f.attempted.length, 2);
    assert.deepEqual(f.delivered, []);
    assert.deepEqual(f.messages, [shortText]);
  });
  add("long Unicode text remains a complete separate message", async () => {
    const text = "😀".repeat(513);
    const f = fixture();
    await f.run(`${text}\n${images}`);
    assert.deepEqual(f.attempted.map(item => item.caption), [undefined, undefined]);
    assert.deepEqual(f.messages, [text]);
  });
  add("1024-unit caption boundary stays on first photo only", async () => {
    const text = "😀".repeat(512);
    const f = fixture();
    await f.run(`${text}\n${images}`);
    assert.deepEqual(f.attempted.map(item => item.caption), [text, undefined]);
    assert.deepEqual(f.messages, []);
  });
  add("image-only success needs no text fallback", async () => {
    const f = fixture(rejectFirst);
    await f.run(images);
    assert.equal(f.delivered.length, 1);
    assert.deepEqual(f.messages, []);
  });
  add("image-only total failure retains existing fallback", async () => {
    const f = fixture(rejectAll);
    await f.run(images);
    assert.deepEqual(f.messages, ["图片暂时无法发送。"]);
  });
  add("single successful photo carries text", async () => {
    const f = fixture();
    await f.run(`${shortText}\n${oneImage}`);
    assert.deepEqual(f.delivered, [{ path: "first image.png", caption: shortText }]);
    assert.deepEqual(f.messages, []);
  });
  add("single rejected photo falls back to text", async () => {
    const f = fixture(rejectAll);
    await f.run(`${shortText}\n${oneImage}`);
    assert.deepEqual(f.messages, [shortText]);
  });
  add("plain text without images stays unchanged", async () => {
    const f = fixture();
    await f.run(`  ${shortText}  `);
    assert.deepEqual(f.attempted, []);
    assert.deepEqual(f.messages, [shortText]);
  });
  add("blank reply sends nothing", async () => {
    const f = fixture();
    await f.run(" \n\t ");
    assert.deepEqual(f.attempted, []);
    assert.deepEqual(f.messages, []);
  });
  add("pending caption is awaited before settlement", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async index => { if (index === 0) await pending; });
    let settled = false;
    const running = f.run(`${shortText}\n${images}`).then(() => { settled = true; });
    assert.equal(f.attempted.length, 1);
    assert.deepEqual(f.delivered, []);
    assert.deepEqual(f.messages, []);
    assert.equal(settled, false);
    release();
    await running;
    assert.equal(settled, true);
    assert.equal(f.delivered.length, 2);
    assert.deepEqual(f.messages, []);
  });
  add("failed text fallback rejects without replaying photos", async () => {
    const error = new Error("inert text failure");
    const f = fixture(rejectFirst, error);
    await assert.rejects(f.run(`${shortText}\n${images}`), candidate => candidate === error);
    assert.equal(f.attempted.length, 2);
    assert.equal(f.delivered.length, 1);
    assert.deepEqual(f.messages, [shortText]);
  });
}
