import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read product sources as text; never import the product, AI SDK or MCP SDK.
// The allowlist evaluates only pure name/argument helpers and the repair hook.
// MCP construction, registry, permissions, host, transport and execution do not run.
const root = new URL("../", import.meta.url);
function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `${source.fileName}: ${name}`);
  return matches[0]!;
}
function extract(source: ts.SourceFile, functions: readonly string[], constants: readonly string[] = []): string {
  const declarations = functions.map(name => namedFunction(source, name).getText(source).replace(/^export\s+/u, ""));
  for (const name of constants) {
    const matches = source.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.equal(matches.length, 1, `${source.fileName}: ${name}`);
    assert.equal(matches[0]!.declarationList.declarations.length, 1, "never evaluate neighboring declarations");
    declarations.push(matches[0]!.getText(source).replace(/^export\s+/u, ""));
  }
  return declarations.join("\n");
}

const mcpSource = sourceFile("src/extensions/mcp.ts");
const createMcpTool = namedFunction(mcpSource, "createMcpTool");
assert.ok(createMcpTool.body);
// Extract the actual naming statements, not a handwritten approximation of
// sanitization, prefixing, reservation checks or lossless/hash branch choice.
const namingVariables = ["serverPart", "toolPart", "baseName", "reserved", "name"];
const namingStatements = createMcpTool.body.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && namingVariables.includes(declaration.name.text)));
assert.deepEqual(namingStatements.flatMap(statement => statement.declarationList.declarations.map(declaration => declaration.name.getText(mcpSource))), namingVariables);
const namingSource = [
  extract(mcpSource, ["normalizeName"]),
  "function modelName(serverName: string, definition: { name: string }): string {",
  ...namingStatements.map(statement => statement.getText(mcpSource)),
  "return name; }",
  "({ modelName });"
].join("\n");
function forbiddenHash(): never { throw new Error("This fixture exercises only the actual lossless MCP name branch"); }
const naming = runInNewContext(stripTypeScriptTypes(namingSource, { mode: "strip" }), { createHash: forbiddenHash }, {
  timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
}) as { modelName(server: string, definition: { name: string }): string };

const repairSource = sourceFile("src/agent/core/toolCallRepair.ts");
const pureRepairSource = [
  extract(sourceFile("src/agent/core/vercelAgentUtils.ts"), ["isRecord"]),
  extract(repairSource, ["normalizeName", "repairToolName", "repairToolArguments", "recoverObjectInput", "schemaTypes", "matchesType", "coerceValue", "fixEnumCase", "parseJsonSilently"], ["parameterAliases", "numericString", "toolCallRepair"]),
  "({ repairToolName, toolCallRepair });"
].join("\n");
const missingToolError = Object.freeze({ kind: "inert-missing-tool" });
interface ToolCall { type: "tool-call"; toolCallId: string; toolName: string; input: string }
interface RepairApi {
  repairToolName(name: string, available: readonly string[]): string | undefined;
  toolCallRepair(options: {
    toolCall: ToolCall;
    tools: Record<string, { execute(): never }>;
    inputSchema(options: { toolName: string }): Promise<unknown>;
    error: unknown;
  }): Promise<ToolCall | null>;
}
const repair = runInNewContext(stripTypeScriptTypes(pureRepairSource, { mode: "strip" }), {
  NoSuchToolError: { isInstance: (error: unknown) => error === missingToolError }
}, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as RepairApi;

const hyphen = naming.modelName("crm", { name: "get-user" });
const underscore = naming.modelName("crm", { name: "get_user" });
const joined = naming.modelName("crm", { name: "getuser" });
const pair = [hyphen, underscore];
const sameSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
function fixture(names: readonly string[], schema: unknown = sameSchema) {
  const schemaRequests: string[] = [];
  let executions = 0;
  const tools = Object.fromEntries(names.map(name => [name, { execute(): never {
    executions += 1;
    throw new Error("Repair must never execute a tool");
  } }]));
  return {
    schemaRequests,
    executions: () => executions,
    async call(name: string, input = '{"id":"123"}', error: unknown = missingToolError): Promise<ToolCall | null> {
      return await repair.toolCallRepair({
        toolCall: { type: "tool-call", toolCallId: "inert-call", toolName: name, input }, tools, error,
        inputSchema: async ({ toolName }) => {
          schemaRequests.push(toolName);
          assert.ok(Object.hasOwn(tools, toolName));
          return schema;
        }
      });
    }
  };
}

test("actual MCP lossless naming preserves separate legal names sharing a repair key", () => {
  assert.equal(hyphen, "mcp_crm_get-user");
  assert.equal(underscore, "mcp_crm_get_user");
  assert.notEqual(hyphen, underscore);
  assert.ok(pair.every(name => /^[A-Za-z0-9_-]{1,64}$/u.test(name)));
});

test("actual prompt-cache ordering puts the underscore candidate last", () => {
  const source = sourceFile("src/llm/promptCache.ts");
  const cache = namedFunction(source, "getToolSchemaCache").getText(source);
  assert.match(cache, /const nameOrder = stableCompare\(left\.name, right\.name\);\s*if \(nameOrder !== 0\) return nameOrder;/u);
  const compare = runInNewContext(stripTypeScriptTypes(`${extract(source, ["stableCompare"])}\n stableCompare;`, { mode: "strip" }), {}, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as (left: string, right: string) => number;
  assert.deepEqual([...pair].sort(compare), pair);
  assert.deepEqual([...pair].reverse().sort(compare), pair);
  // This models the actual order only. Reverse-order repair cases below are
  // generic order-independence checks, not an assertion about MCP discovery.
});

for (const names of [pair, [...pair].reverse()]) {
  for (const typo of ["MCP_CRM_GET-USER", "mcpcrmgetuser", "mcp_crm_get__user"]) {
    test(`ambiguous ${typo} is rejected with candidates ${names.join(",")}`, async () => {
      assert.equal(repair.repairToolName(typo, names), undefined);
      const f = fixture(names);
      assert.equal(await f.call(typo), null);
      assert.deepEqual(f.schemaRequests, [], "do not choose a target schema for an ambiguous name");
      assert.equal(f.executions(), 0);
    });
  }
}

test("public repair hook rejects ambiguity before asking for either compatible schema", async () => {
  const f = fixture(pair);
  assert.equal(await f.call("MCP_CRM_GET-USER"), null);
  assert.deepEqual(f.schemaRequests, []);
  assert.equal(f.executions(), 0);
});

test("three normalized candidates are still ambiguous", async () => {
  const f = fixture([joined, ...pair]);
  assert.equal(await f.call("MCPCRMGETUSER"), null);
  assert.deepEqual(f.schemaRequests, []);
  assert.equal(f.executions(), 0);
});

for (const exact of pair) {
  test(`exact name ${exact} remains authoritative among colliding names`, async () => {
    assert.equal(repair.repairToolName(exact, pair), exact);
    const f = fixture(pair, { type: "object", properties: { count: { type: "integer" } }, additionalProperties: false });
    const result = await f.call(exact, '{"count":"2"}', { kind: "inert-input-error" });
    assert.equal(result?.toolName, exact);
    assert.equal(result?.toolCallId, "inert-call");
    assert.deepEqual(JSON.parse(result?.input ?? "null"), { count: 2 });
    assert.deepEqual(f.schemaRequests, [exact]);
    assert.equal(f.executions(), 0);
  });
}

test("unique normalized variant still repairs the name and preserves valid arguments", async () => {
  const f = fixture([hyphen]);
  const result = await f.call("MCP_CRM_GET-USER");
  assert.equal(result?.toolName, hyphen);
  assert.deepEqual(JSON.parse(result?.input ?? "null"), { id: "123" });
  assert.deepEqual(f.schemaRequests, [hyphen]);
  assert.equal(f.executions(), 0);
});

test("repeated identical candidate is not a second distinct identity", () => {
  assert.equal(repair.repairToolName("MCP_CRM_GET-USER", [hyphen, hyphen]), hyphen);
});

test("unmatched name and empty available set stay unrepaired", async () => {
  for (const names of [pair, []]) {
    const f = fixture(names);
    assert.equal(await f.call("nonexistent_tool"), null);
    assert.deepEqual(f.schemaRequests, []);
    assert.equal(f.executions(), 0);
  }
});

test("ordinary argument aliases and scalar coercion remain available", async () => {
  const f = fixture(["Read"], { type: "object", properties: { path: { type: "string" }, lineCount: { type: "integer" } }, additionalProperties: false });
  const result = await f.call("Read", '{"filepath":"notes.md","lineCount":"2"}', { kind: "inert-input-error" });
  assert.equal(result?.toolName, "Read");
  assert.deepEqual(JSON.parse(result?.input ?? "null"), { path: "notes.md", lineCount: 2 });
  assert.deepEqual(f.schemaRequests, ["Read"]);
  assert.equal(f.executions(), 0);
});

test("ambiguous parameter aliases still decline repair", async () => {
  const f = fixture(["Search"], { type: "object", properties: { maxResults: { type: "integer" }, lineCount: { type: "integer" } }, additionalProperties: false });
  assert.equal(await f.call("Search", '{"maxcount":2}', { kind: "inert-input-error" }), null);
  assert.deepEqual(f.schemaRequests, ["Search"]);
  assert.equal(f.executions(), 0);
});

test("already valid exact call produces no unnecessary repair", async () => {
  const f = fixture(pair);
  assert.equal(await f.call(hyphen, '{"id":"123"}', { kind: "inert-input-error" }), null);
  assert.deepEqual(f.schemaRequests, [hyphen]);
  assert.equal(f.executions(), 0);
});
