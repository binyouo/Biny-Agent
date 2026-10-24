import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only declarations read from this checkout execute, inside an isolated VM.
// Schema validation, configuration persistence and Desktop transport are inert
// collaborators. This is not a real schema, CLI process, Host, socket, Keychain,
// safeStorage or provider integration. Never import application modules here.
const root = new URL("../", import.meta.url);
function declarations(relative: string, names: readonly string[], optional: readonly string[] = []): string {
  const source = ts.createSourceFile(relative, readFileSync(new URL(relative, root), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return [...names, ...optional].map(name => {
    const found = source.statements.filter(node =>
      ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
    if (optional.includes(name) && found.length === 0) return "";
    assert.equal(found.length, 1, `${relative}: exactly one ${name}`);
    const node = found[0]!;
    if (ts.isVariableStatement(node)) assert.equal(node.declarationList.declarations.length, 1, "Do not execute adjacent declarations");
    return node.getText(source).replace(/^export\s+/u, "");
  }).join("\n");
}
const selectedSource = [
  declarations("src/utils/redaction.ts", ["redactSecrets"]),
  declarations("src/utils/secrets.ts", ["redactSensitiveValue", "redactSensitiveValueInternal", "isSensitiveFieldName"]),
  declarations("src/config/settingPath.ts", ["readSetting", "writeSetting"]),
  declarations("src/config/store.ts", ["configUpdateMaxAttempts", "updateConfig"]),
  declarations("src/config/commands.ts", ["executeConfigurationCommand"], ["redactConfigurationOutput"]),
  declarations("src/cli/commands/configuration.ts", ["registerConfigurationCommands", "desktopPreferencePath"])
].join("\n");
const executableSource = stripTypeScriptTypes(selectedSource, { mode: "strip" })
  + "\n({ executeConfigurationCommand, registerConfigurationCommands, redactSensitiveValue });";

interface Server {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  credentialRefs?: { env?: Record<string, string>; headers?: Record<string, string> };
}
interface Configuration {
  providers: Record<string, { type: string; apiKey?: string; oauth?: { refreshToken: string }; apiKeyEnv?: string }>;
  extensions: { mcp: Record<string, Server> };
  credentialRevisions: Record<string, string>;
  label: string;
}
interface Store {
  load(root?: string): Promise<Configuration>;
  loadVersioned(root?: string): Promise<{ config: Configuration; revision: string }>;
  saveVersioned(config: Configuration, revision: string, root?: string): Promise<{ config: Configuration; revision: string }>;
}
interface Api {
  executeConfigurationCommand(store: Store, action: string, input: Record<string, unknown>, root?: string): Promise<unknown>;
  registerConfigurationCommands(program: FakeCommand, wrap: (action: () => Promise<void>) => () => Promise<void>): void;
  redactSensitiveValue(value: unknown): unknown;
}
type Action = (...args: unknown[]) => unknown;
class FakeCommand {
  private callback: Action | undefined;
  readonly children = new Map<string, FakeCommand>();
  command(name: string): FakeCommand { const child = new FakeCommand(); this.children.set(name, child); return child; }
  description(_text: string): this { return this; }
  argument(_name: string, _description?: string): this { return this; }
  option(_name: string, _description?: string): this { return this; }
  requiredOption(_name: string, _description?: string): this { return this; }
  action(callback: Action): this { this.callback = callback; return this; }
  async invoke(...args: unknown[]): Promise<void> { assert.ok(this.callback); await this.callback(...args); }
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) current = record(current)[key];
  return current;
}
function seed(): Configuration {
  return {
    providers: { example: { type: "fixture", apiKey: "SYNTH_PROVIDER", oauth: { refreshToken: "SYNTH_REFRESH" }, apiKeyEnv: "PUBLIC_KEY_ENV" } },
    extensions: { mcp: {
      fixture: {
        env: { VALUE: "SYNTH_REFERENCED", EMPTY: "", MODE: "visible", value: "case-public", COPY: "SYNTH_REFERENCED", AUTH_TOKEN: "SYNTH_NAMED" },
        headers: { "X-Auth": "SYNTH_HEADER", "X-Public": "visible" },
        credentialRefs: { env: { VALUE: "synthetic-account", EMPTY: "synthetic-empty", MISSING: "synthetic-missing", AUTH_TOKEN: "synthetic-token-account" }, headers: { "X-Auth": "synthetic-header" } }
      },
      second: { env: { VALUE: "SECOND_PRIVATE" }, credentialRefs: { env: { VALUE: "second-account" } } },
      absent: { credentialRefs: { env: { MISSING: "absent-account" }, headers: { MISSING: "absent-header" } } },
      noRefs: { env: { VALUE: "public-unreferenced" } },
      emptyRefs: { headers: { "X-Public": "public-empty-ref" }, credentialRefs: { env: {}, headers: {} } }
    } },
    credentialRevisions: { "synthetic-account": "public-revision" },
    label: "public configuration"
  };
}
function forbidden(): never { throw new Error("Unexpected inert collaborator call"); }
interface StringSchema {
  optional(): StringSchema;
  min(value: number): StringSchema;
  parse(value: unknown): string | undefined;
}
function stringSchema(optional = false): StringSchema {
  return {
    optional: () => stringSchema(true),
    min: (_value: number) => stringSchema(optional),
    parse(value: unknown): string | undefined {
      if (optional && value === undefined) return undefined;
      assert.equal(typeof value, "string");
      return value as string;
    }
  };
}
function harness(route: "file" | "desktop", input = seed()) {
  const initial = frozen(structuredClone(input));
  let current = initial;
  let saves = 0;
  let fileCalls = 0;
  let desktopCalls = 0;
  const lines: string[] = [];
  const store: Store = {
    async load() { return current; },
    async loadVersioned() { return { config: current, revision: "fixture-revision" }; },
    async saveVersioned(config, revision) {
      assert.equal(revision, "fixture-revision");
      saves += 1;
      current = frozen(structuredClone(config));
      return { config: current, revision: "fixture-revision" };
    }
  };
  const bindings = {
    structuredClone,
    globalConfigDir: () => "/synthetic-config-root",
    z: { string: () => stringSchema() },
    // Identity is deliberately not real Zod validation. Only synthetic
    // projection/update shapes are modeled, not complete schema validity.
    configSchema: { parse: (value: unknown) => value },
    ConfigRevisionConflictError: class ConfigRevisionConflictError extends Error {},
    FileModelsStore: forbidden, restoreProviderCatalogs: forbidden,
    listModelChoices: forbidden, saveModelSelection: forbidden,
    existsSync: (path: string) => { assert.equal(path, "/synthetic-config-root/credentials.enc"); return route === "desktop"; },
    path: { join: (...parts: string[]) => parts.join("/") },
    readFile: forbidden,
    createFileConfigStore: (path: string) => { assert.equal(path, "/synthetic-config-root"); fileCalls += 1; return store; },
    requestDesktopCommand: async (action: string, args: Record<string, unknown>) => {
      assert.equal(action, "configuration");
      desktopCalls += 1;
      const result = await api.executeConfigurationCommand(store, String(args.operation), record(args.input));
      // Simulated JSON transport plus the existing receiving projection. The
      // real Desktop service and requestBrowser are source-reviewed, not run.
      const response = JSON.parse(JSON.stringify({ result })) as { result?: unknown };
      return api.redactSensitiveValue(response.result);
    },
    console: { log: (line: unknown) => { assert.equal(typeof line, "string"); lines.push(line as string); } }
  };
  const api: Api = runInNewContext(executableSource, bindings, {
    timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Api;
  const program = new FakeCommand();
  api.registerConfigurationCommands(program, action => action);
  const command = (group: string, verb: string): FakeCommand => {
    const found = program.children.get(group)?.children.get(verb);
    assert.ok(found); return found;
  };
  return {
    api, store, initial, lines, command,
    current: () => current,
    saves: () => saves,
    assertRoute: () => {
      assert.equal(route === "file" ? fileCalls : desktopCalls, 1);
      assert.equal(route === "file" ? desktopCalls : fileCalls, 0);
    }
  };
}

for (const route of ["file", "desktop"] as const) {
  const gets: Array<{ label: string; path?: string; relative?: string; expected?: string; pretty?: boolean }> = [
    { label: "root" },
    { label: "parent", path: "extensions.mcp.fixture", relative: "env.VALUE", pretty: true },
    { label: "env leaf", path: "extensions.mcp.fixture.env.VALUE", expected: "[redacted]" },
    { label: "header leaf", path: "extensions.mcp.fixture.headers.X-Auth", expected: "[redacted]", pretty: true },
    { label: "empty credential", path: "extensions.mcp.fixture.env.EMPTY", expected: "[redacted]" }
  ];
  for (const item of gets) test(`${route}: get ${item.label} masks only the explicit credential leaves`, async () => {
    const input = seed();
    const f = harness(route, input);
    await f.command("config", "get").invoke(item.path, { json: !item.pretty });
    assert.equal(f.lines.length, 1);
    const text = f.lines[0]!;
    const output: unknown = JSON.parse(text);
    assert.equal(text, JSON.stringify(output, null, item.pretty ? 2 : undefined));
    if (item.path === undefined) {
      assert.equal(at(output, "extensions.mcp.fixture.env.VALUE"), "[redacted]");
      assert.equal(at(output, "extensions.mcp.fixture.headers.X-Auth"), "[redacted]");
      assert.equal(at(output, "extensions.mcp.second.env.VALUE"), "[redacted]");
      assert.equal(at(output, "extensions.mcp.fixture.env.COPY"), "SYNTH_REFERENCED", "No global value substitution");
    } else if (item.relative) assert.equal(at(output, item.relative), "[redacted]");
    else assert.equal(output, item.expected);
    assert.deepEqual(f.current(), input);
    assert.deepEqual(f.initial, input);
    assert.equal(f.saves(), 0);
    f.assertRoute();
  });
  for (const kind of ["leaf", "parent"] as const) test(`${route}: set ${kind} masks its receipt without changing saved values`, async () => {
    const f = harness(route);
    const before = structuredClone(f.initial);
    const path = kind === "leaf" ? "extensions.mcp.fixture.env.VALUE" : "extensions.mcp.fixture";
    const value = kind === "leaf" ? "SYNTH_UPDATED 😀 ' \" value"
      : { ...structuredClone(f.initial.extensions.mcp.fixture!), env: { ...f.initial.extensions.mcp.fixture!.env, VALUE: "SYNTH_UPDATED" } };
    const valueBefore = structuredClone(value);
    await f.command("config", "set").invoke(path, JSON.stringify(value), { json: true });
    assert.equal(f.lines.length, 1);
    const output = record(JSON.parse(f.lines[0]!));
    assert.equal(output.path, path);
    if (kind === "leaf") assert.equal(output.value, "[redacted]");
    else {
      assert.equal(at(output.value, "env.VALUE"), "[redacted]");
      assert.equal(at(output.value, "headers.X-Auth"), "[redacted]");
      assert.equal(at(output.value, "env.MODE"), "visible");
    }
    assert.deepEqual(at(f.current(), path), value);
    assert.deepEqual(f.initial, before);
    assert.deepEqual(value, valueBefore);
    assert.equal(f.saves(), 1);
    f.assertRoute();
  });
  test(`${route}: public fields, exact case and metadata keep existing generic behavior`, async () => {
    const f = harness(route);
    await f.command("config", "get").invoke(undefined, { json: true });
    const output: unknown = JSON.parse(f.lines[0]!);
    for (const [path, expected] of [
      ["extensions.mcp.fixture.env.value", "case-public"],
      ["extensions.mcp.fixture.env.COPY", "SYNTH_REFERENCED"],
      ["extensions.mcp.fixture.env.MODE", "visible"],
      ["extensions.mcp.fixture.headers.X-Public", "visible"],
      ["extensions.mcp.fixture.credentialRefs.env.VALUE", "synthetic-account"],
      ["extensions.mcp.fixture.credentialRefs.env.AUTH_TOKEN", "[redacted]"],
      ["extensions.mcp.fixture.env.AUTH_TOKEN", "[redacted]"],
      ["credentialRevisions.synthetic-account", "public-revision"],
      ["extensions.mcp.noRefs.env.VALUE", "public-unreferenced"],
      ["extensions.mcp.emptyRefs.headers.X-Public", "public-empty-ref"],
      ["providers.example.apiKey", "[redacted]"],
      ["providers.example.oauth.refreshToken", "[redacted]"],
      ["providers.example.apiKeyEnv", "PUBLIC_KEY_ENV"]
    ]) assert.equal(at(output, path!), expected);
    assert.equal(Object.hasOwn(record(at(output, "extensions.mcp.absent")), "env"), false);
    assert.equal(Object.hasOwn(record(at(output, "extensions.mcp.fixture.env")), "MISSING"), false);
    assert.deepEqual(f.current(), f.initial);
    f.assertRoute();
  });
  test(`${route}: missing referenced and unknown paths still fail without printing or saving`, async () => {
    for (const path of ["extensions.mcp.fixture.env.MISSING", "extensions.mcp.absent.env.MISSING", "extensions.mcp.absent.headers.MISSING", "unknown.path"]) {
      const f = harness(route);
      await assert.rejects(f.command("config", "get").invoke(path, { json: true }), (error: unknown) => {
        assert.equal(record(error).message, `Unknown setting: ${path}`); return true;
      });
      assert.deepEqual(f.lines, []);
      assert.equal(f.saves(), 0);
      assert.deepEqual(f.current(), f.initial);
      f.assertRoute();
    }
  });
  test(`${route}: provider list keeps its unchanged output contract`, async () => {
    const f = harness(route);
    await f.command("provider", "list").invoke({ json: true });
    const output: unknown = JSON.parse(f.lines[0]!);
    assert.equal(at(output, "providers.example.apiKey"), "[redacted]");
    assert.equal(at(output, "providers.example.oauth.refreshToken"), "[redacted]");
    assert.equal(at(output, "providers.example.apiKeyEnv"), "PUBLIC_KEY_ENV");
    assert.deepEqual(f.current(), f.initial);
    f.assertRoute();
  });
}

test("ordinary nested data keeps actual generic redaction and does not acquire configuration policy", () => {
  const f = harness("file");
  const input = frozen({ records: [{ password: "SYNTH_PASSWORD", value: "visible" }], text: "token=SYNTH_TEXT", nextPageToken: "SYNTH_CURSOR" });
  assert.equal(JSON.stringify(f.api.redactSensitiveValue(input)), JSON.stringify({
    records: [{ password: "[redacted]", value: "visible" }], text: "token=[redacted]", nextPageToken: "[redacted]"
  }));
  assert.equal(input.records[0]!.password, "SYNTH_PASSWORD");
  assert.equal(input.text, "token=SYNTH_TEXT");
});
