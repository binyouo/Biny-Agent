/** Actual page program and Desktop upload branch; inert DOM only, no product imports or resources. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const pageText = readFileSync(path.join(process.cwd(), "src/browser-extension/page.js"), "utf8");
const pageSource = ts.createSourceFile("page.js", pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const pageFunction = pageSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "pageOperation");
assert.ok(pageFunction?.body);
const pageExpression = pageFunction.getText(pageSource).replace(/^export\s+/u, "");
const serviceText = readFileSync(path.join(process.cwd(), "src/desktop/electron/main/DesktopBrowserService.ts"), "utf8");
const serviceSource = ts.createSourceFile("service.ts", serviceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const serviceClass = serviceSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopBrowserService");
assert.ok(serviceClass);
const execute = serviceClass.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "executeAutomation");
assert.ok(execute?.body);
const uploadBranch = execute.body.statements.find((node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(serviceSource) === 'method === "upload"');
assert.ok(uploadBranch && ts.isBlock(uploadBranch.thenStatement));
const uploadBody = uploadBranch.thenStatement.getText(serviceSource);
const branchCalls: string[] = [];
function inspectBranch(node: ts.Node): void {
  if (ts.isCallExpression(node)) branchCalls.push(node.expression.getText(serviceSource));
  assert.ok(!ts.isNewExpression(node), "Desktop upload branch must not create resources");
  ts.forEachChild(node, inspectBranch);
}
inspectBranch(uploadBranch.thenStatement);
assert.deepEqual(branchCalls, ["relaySchemas.upload.shape.files.parse", "readString", "this.pageOperation"]);
const pageScript = new Script(`globalThis.pageApi = (${pageExpression});`);
const desktopScript = new Script(`globalThis.desktopApi = async function(args, signal, contents, onAction) ${uploadBody};`);

interface UploadFile { name: string; mimeType: string; data: string }
interface UploadArgs { selector: string; files: UploadFile[]; desktopUploadReceipt?: boolean }
type PageApi = (operation: string, args: UploadArgs) => Promise<unknown>;
interface DesktopOwner {
  pageOperation(operation: string, args: UploadArgs, signal: unknown, contents: unknown, onAction: unknown): Promise<unknown>;
}
type DesktopApi = (this: DesktopOwner, args: { selector: string; files: UploadFile[]; desktopUploadReceipt?: boolean }, signal: unknown, contents: unknown, onAction: unknown) => Promise<unknown>;
class InertFile {
  constructor(readonly parts: Uint8Array[], readonly name: string, readonly options: { type: string }) {}
}
class InertEvent {
  constructor(readonly type: string, readonly options: { bubbles: boolean }) {}
}
class InertTransfer {
  files: InertFile[] = [];
  items = { add: (file: InertFile): void => { this.files.push(file); } };
}
class InertInput {
  type = "file";
  multiple = false;
  disabled = false;
  files: InertFile[] = [];
  events: string[] = [];
  onEvent: ((event: InertEvent) => void) | undefined;
  matches(selector: string): boolean {
    assert.equal(selector, ':disabled,[aria-disabled="true"]');
    return this.disabled;
  }
  dispatchEvent(event: InertEvent): void {
    assert.equal(event.options.bubbles, true);
    this.events.push(event.type);
    this.onEvent?.(event);
  }
}
const file: UploadFile = { name: "request.txt", mimeType: "text/plain", data: "YQ==" };
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function fixture() {
  const input = new InertInput();
  let lookups = 0;
  const context = createContext({
    document: { querySelectorAll: (selector: string): InertInput[] => { lookups++; return selector === "#file" ? [input] : []; } },
    HTMLElement: InertInput, HTMLInputElement: InertInput,
    File: InertFile, Event: InertEvent, DataTransfer: InertTransfer, Uint8Array,
    atob: (value: string): string => { assert.equal(value, "YQ=="); return "a"; }
  }, { codeGeneration: { strings: false, wasm: false } });
  pageScript.runInContext(context, { timeout: 1000 });
  const run = context.pageApi as PageApi;
  return { input, run: (receipt?: boolean) => run("upload", { selector: "#file", files: [file], ...(receipt === undefined ? {} : { desktopUploadReceipt: receipt }) }),
    raw: run, lookups: () => lookups };
}

test("Desktop receipt reports actual assigned File names and count after both events", async () => {
  const f = fixture();
  const result = plain(await f.run(true));
  assert.equal(Object.hasOwn(Object(result), "names"), true);
  assert.deepEqual(result, { count: 1, names: ["request.txt"] });
  assert.deepEqual(f.input.events, ["input", "change"]);
  assert.equal(f.input.files[0]?.parts[0]?.[0], 97);
  assert.equal(f.lookups(), 1);
});

test("Desktop receipt observes event-replaced or cleared FileList, not request metadata", async () => {
  for (const clear of [false, true]) {
    const f = fixture();
    f.input.onEvent = event => {
      if (event.type === "change") f.input.files = clear ? [] : [new InertFile([], "page-selected.txt", { type: "text/plain" })];
    };
    const result = plain(await f.run(true));
    assert.equal(Object.hasOwn(Object(result), "names"), true);
    assert.deepEqual(result, { count: clear ? 0 : 1, names: clear ? [] : ["page-selected.txt"] });
    assert.deepEqual(f.input.events, ["input", "change"]);
    assert.equal(f.lookups(), 1);
  }
});

test("Default and explicit false keep the original count-only transfer receipt", async () => {
  for (const receipt of [undefined, false]) {
    const f = fixture();
    f.input.onEvent = event => { if (event.type === "change") f.input.files = []; };
    assert.deepEqual(plain(await f.run(receipt)), { count: 1 });
    assert.deepEqual(f.input.events, ["input", "change"]);
    assert.equal(f.lookups(), 1);
  }
});

test("Missing, disabled and incompatible inputs fail without assigning files or dispatching events", async () => {
  for (const kind of ["missing", "disabled", "wrong-type", "multiple"]) {
    const f = fixture();
    f.input.disabled = kind === "disabled";
    if (kind === "wrong-type") f.input.type = "text";
    await assert.rejects(f.raw("upload", { selector: kind === "missing" ? "#missing" : "#file", files: kind === "multiple" ? [file, file] : [file], desktopUploadReceipt: true }));
    assert.deepEqual(f.input.events, []);
    assert.deepEqual(f.input.files, []);
    assert.equal(f.lookups(), 1);
  }
});

test("Event errors propagate without retry, additional lookup or later events", async () => {
  for (const failAt of ["input", "change"]) {
    const f = fixture(); const failure = new Error(`synthetic ${failAt} failure`);
    f.input.onEvent = event => { if (event.type === failAt) throw failure; };
    await assert.rejects(f.run(true), error => error === failure);
    assert.deepEqual(f.input.events, failAt === "input" ? ["input"] : ["input", "change"]);
    assert.equal(f.lookups(), 1);
  }
});

test("Actual Desktop branch validates first and opts into one page operation on the same owner", async () => {
  const validationFailure = new Error("synthetic invalid files");
  let rejectValidation = false; let parses = 0; let calls = 0;
  const context = createContext({
    relaySchemas: { upload: { shape: { files: { parse: (value: UploadFile[]): UploadFile[] => { parses++; if (rejectValidation) throw validationFailure; return value; } } } } },
    readString: (value: unknown, name: string): string => { assert.equal(name, "selector"); assert.equal(typeof value, "string"); return String(value); }
  }, { codeGeneration: { strings: false, wasm: false } });
  desktopScript.runInContext(context, { timeout: 1000 });
  const run = context.desktopApi as DesktopApi;
  const f = fixture(); const signal = {}; const contents = {}; const onAction = {};
  const owner: DesktopOwner = { pageOperation: async (operation, args, receivedSignal, receivedContents, receivedAction) => {
    calls++; assert.equal(operation, "upload"); assert.equal(args.desktopUploadReceipt === true, true);
    assert.equal(receivedSignal, signal); assert.equal(receivedContents, contents); assert.equal(receivedAction, onAction);
    return await f.raw(operation, args);
  } };
  assert.deepEqual(plain(await run.call(owner, { selector: "#file", files: [file], desktopUploadReceipt: false }, signal, contents, onAction)), { count: 1, names: ["request.txt"] });
  assert.equal(calls, 1); assert.equal(parses, 1); assert.equal(f.lookups(), 1);
  rejectValidation = true;
  await assert.rejects(run.call(owner, { selector: "#file", files: [file] }, signal, contents, onAction), error => error === validationFailure);
  assert.equal(calls, 1); assert.equal(parses, 2); assert.equal(f.lookups(), 1);
  assert.deepEqual(f.input.events, ["input", "change"]);
});
