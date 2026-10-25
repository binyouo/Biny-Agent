/** Actual command callbacks and read/redaction helpers; no application imports or live configuration. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

function source(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(path.resolve(file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function functions(file: string, names: string[]): string {
  const parsed = source(file);
  const declarations = names.map(name => {
    const matches = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `exact source function ${name}`);
    return matches[0]!.getText(parsed).replace(/^export\s+/u, "");
  });
  const output = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const compiled = ts.createSourceFile("inert.js", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.ok(compiled.statements.every(ts.isFunctionDeclaration), "only selected function declarations may execute");
  return output;
}

const commands = functions("src/cli/commands/configuration.ts", ["registerConfigurationCommands", "desktopPreferencePath"]);
const dispatch = functions("src/config/commands.ts", ["executeConfigurationCommand"]);
const setting = functions("src/config/settingPath.ts", ["readSetting"]);
const redaction = functions("src/utils/secrets.ts", ["redactSensitiveValue", "redactSensitiveValueInternal", "isSensitiveFieldName"]);
const wrapper = functions("src/cli/index.ts", ["wrap"]);

class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  callback?: (...args: unknown[]) => Promise<void>;
  command(name: string): FakeCommand { const child = new FakeCommand(); this.children.set(name, child); return child; }
  description(): this { return this; }
  argument(): this { return this; }
  option(): this { return this; }
  requiredOption(): this { return this; }
  action(callback: (...args: unknown[]) => Promise<void>): this { this.callback = callback; return this; }
}

function fixture(config: Record<string, unknown>, encrypted = false, failure?: Error) {
  const stdout: string[] = [], stderr: string[] = [];
  const processState = { exitCode: 0 };
  const calls: string[] = [];
  const forbidden = (): never => { throw new Error("Unexpected side effect in inert configuration fixture"); };
  const store = { async load(root: string) {
    assert.equal(root, "/synthetic-agent");
    calls.push("load");
    if (failure) throw failure;
    return structuredClone(config);
  } };
  const sandbox = vm.createContext({
    z, Error, structuredClone, process: processState,
    console: { log: (...values: unknown[]) => stdout.push(format(...values)), error: (...values: unknown[]) => stderr.push(format(...values)) },
    globalConfigDir: () => "/synthetic-agent",
    path: { join: (...parts: string[]) => parts.join("/") },
    existsSync: (file: string) => { assert.equal(file, "/synthetic-agent/credentials.enc"); return encrypted; },
    createFileConfigStore: (root: string) => { assert.equal(root, "/synthetic-agent"); assert.equal(encrypted, false); return store; },
    // Plain synthetic labels only. Field-name redaction runs unchanged below; text secret recognition is not under test.
    redactSecrets: (value: string) => value,
    readFile: forbidden, writeSetting: forbidden, updateConfig: forbidden,
    configSchema: { parse: forbidden }, FileModelsStore: forbidden,
    restoreProviderCatalogs: forbidden, listModelChoices: forbidden, saveModelSelection: forbidden
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(`${setting}\n${redaction}\n${dispatch}\n${commands}\n${wrapper}`, sandbox);
  sandbox.requestDesktopCommand = async (action: string, args: { operation?: string; input?: Record<string, unknown>; path?: string }) => {
    calls.push(action);
    if (action === "preferences.get") {
      assert.equal(args.path, "themePreference");
      return "system";
    }
    assert.equal(action, "configuration");
    assert.equal(encrypted, true);
    assert.equal(args.operation, "config.get");
    // The transport is inert, but both routes execute the same actual configuration dispatcher.
    return await sandbox.executeConfigurationCommand(store, args.operation, args.input, "/synthetic-agent");
  };
  const program = new FakeCommand();
  sandbox.registerConfigurationCommands(program, sandbox.wrap);
  return { stdout, stderr, calls, processState,
    async get(key?: string, json = true) { await program.children.get("config")!.children.get("get")!.callback!(key, { json }); }
  };
}

test("default source explicitly contains absent optional values used by this fixture", () => {
  const parsed = source("src/config/schema.ts");
  const declaration = parsed.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === "defaultConfig");
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
    const entry = object.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(parsed) === name);
    assert.ok(entry && ts.isPropertyAssignment(entry));
    return entry.initializer;
  }
  assert.equal(property(declaration.initializer, "toolModel").getText(parsed), "undefined");
  const chat = property(declaration.initializer, "chat");
  assert.ok(ts.isObjectLiteralExpression(chat));
  assert.equal(property(chat, "temperature").getText(parsed), "undefined");
});

for (const encrypted of [false, true]) {
  test(`JSON get returns null for own absent optional values (${encrypted ? "desktop" : "file"} route)`, async () => {
    const state = fixture({ toolModel: undefined, chat: { temperature: undefined } }, encrypted);
    await state.get("toolModel");
    await state.get("chat.temperature");
    assert.deepEqual(state.stdout, ["null", "null"]);
    assert.deepEqual(state.stdout.map(value => JSON.parse(value)), [null, null]);
    assert.equal(state.processState.exitCode, 0);
    assert.deepEqual(state.stderr, []);
    assert.equal(state.calls.filter(value => value === "configuration").length, encrypted ? 2 : 0);
  });
}

test("JSON get preserves defined falsy values, ordinary scalars and nested JSON omission", async () => {
  const state = fixture({ values: { disabled: false, zero: 0, empty: "", nothing: null, label: "plain", absent: undefined, array: [undefined, false, 0] } });
  for (const key of ["disabled", "zero", "empty", "nothing", "label"]) await state.get(`values.${key}`);
  await state.get("values");
  assert.deepEqual(state.stdout, ["false", "0", '""', "null", '"plain"', '{"disabled":false,"zero":0,"empty":"","nothing":null,"label":"plain","array":[null,false,0]}']);
  assert.equal(state.processState.exitCode, 0);
});

test("pretty output renders absent optional values as JSON null and retains indentation", async () => {
  const state = fixture({ optional: undefined, object: { enabled: false } });
  await state.get("optional", false);
  await state.get("object", false);
  assert.deepEqual(state.stdout, ["null", '{\n  "enabled": false\n}']);
});

test("omitted path returns the whole redacted configuration with nested absence omitted", async () => {
  const state = fixture({ optional: undefined, providers: { fixture: { apiKey: "synthetic-only" } }, enabled: false });
  await state.get();
  assert.deepEqual(state.stdout, ['{"providers":{"fixture":{"apiKey":"[redacted]"}},"enabled":false}']);
});

for (const encrypted of [false, true]) {
  test(`unknown paths remain errors rather than null (${encrypted ? "desktop" : "file"} route)`, async () => {
    const state = fixture({ chat: {}, scalar: 1, nothing: null }, encrypted);
    for (const key of ["missing", "chat.missing", "chat.missing.deeper", "scalar.child", "nothing.child"]) await state.get(key);
    assert.deepEqual(state.stdout, []);
    assert.deepEqual(state.stderr, ["missing", "chat.missing", "chat.missing.deeper", "scalar.child", "nothing.child"].map(key => `Unknown setting: ${key}`));
    assert.equal(state.processState.exitCode, 1);
  });
}

test("failed configuration load has no success output and sets failure status", async () => {
  const state = fixture({}, false, new Error("Synthetic read failed"));
  await state.get("optional");
  assert.deepEqual(state.stdout, []);
  assert.deepEqual(state.stderr, ["Synthetic read failed"]);
  assert.equal(state.processState.exitCode, 1);
});

test("desktop preference get keeps its separate routing and JSON scalar", async () => {
  const state = fixture({});
  await state.get("themePreference");
  assert.deepEqual(state.stdout, ['"system"']);
  assert.deepEqual(state.calls, ["preferences.get"]);
});
