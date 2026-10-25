import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Run only the actual bounded reader and persistence method. Do not import the
// coordinator's runtime graph or start a Host, session, provider or Code Mode VM.
const skillSource = await fs.readFile(new URL("../src/extensions/skills.ts", import.meta.url), "utf8");
const coordinatorSource = await fs.readFile(new URL("../src/agent/toolExecutionCoordinator.ts", import.meta.url), "utf8");
const allowedCalls = new Set(["BigInt", "String", "source", "assertReadableSkillResource", "assertSkillFileBinding", "currentBundle",
  "errorMessage", "escapesRoot", "isNotFound", "isSymbolicLinkError", "noFollowFlag", "readBoundedSkillFile",
  "readSkillResourceFresh", "resolveSkill", "resolveSkillResourcePath", "sameSkillSnapshot", "skillSnapshot",
  "readStringField", "serializeToolResult", "toolResultPreview", "readResultLineRange", "archiveToolResult", "formatToolError"]);
const allowedMethods = new Set(["allocUnsafe", "concat", "toString", "min", "readFile", "find", "map", "join", "subarray",
  "push", "includes", "trim", "isFile", "lstat", "open", "realpath", "close", "read", "stat", "dirname", "isAbsolute",
  "relative", "resolve", "isSymbolicLink", "safeParse", "startsWith", "toLowerCase", "throwIfAborted", "object", "string",
  "refine", "add", "isArray", "isFinite", "hasOwn", "exec", "endsWith", "byteLength", "test"]);
function checkExtracted(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node));
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isIdentifier(callee) && allowedCalls.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && allowedMethods.has(callee.name.text), "Unreviewed call: " + callee.getText());
  }
  if (ts.isNewExpression(node)) assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "Error");
  ts.forEachChild(node, checkExtracted);
}
function declarations(source: string, names: string[]): string {
  const parsed = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const statement = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === name));
    assert.ok(statement, `Source declaration ${name} must exist`);
    checkExtracted(statement);
    return statement.getText(parsed).replace(/^export /u, "");
  }).join("\n");
}
const readerDeclarations = declarations(skillSource, ["maxSkillResourceBytes", "readSkillResourceArgsSchema", "createSkillResourceTool",
  "currentBundle", "resolveSkill", "resolveSkillResourcePath", "assertReadableSkillResource", "readSkillResourceFresh",
  "readBoundedSkillFile", "assertSkillFileBinding", "skillSnapshot", "sameSkillSnapshot", "escapesRoot", "isNotFound",
  "noFollowFlag", "isSymbolicLinkError", "errorMessage"]);
type Result = Record<string, unknown>;
interface Definition { name: string; filePath: string; rootPath: string; path: string }
interface Bundle { skills: Definition[]; instructions: Record<string, string>; paths: string[]; prompt: string; warnings: string[]; conflicts: string[]; errors: string[] }
interface Execution { execute(context: { toolCallId: string; operationId: string; signal?: AbortSignal }): Promise<Result> }
interface Failure { isError: true; result: string; errorMessage: string }
interface ReaderTool { resolveExecution(args: { skill: string; path: string }): Promise<Execution | Failure> }
type ReaderFactory = (bundle: Bundle) => ReaderTool;
function reader(fileSystem = fs): ReaderFactory {
  return compileFunction(stripTypeScriptTypes(readerDeclarations) + "\nreturn createSkillResourceTool;",
    ["fs", "path", "constants", "z", "ToolAccesses"])(fileSystem, path, constants, z,
    { readFile: (filePath: string) => [{ kind: "file", operation: "read", path: path.resolve(filePath), recursive: false }] }) as ReaderFactory;
}
async function fixture(action: (value: { root: string; filePath: string; content: string; bundle: Bundle }) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-skill-evidence-")));
  try {
    const filePath = path.join(root, "SKILL.md");
    const content = "---\nname: image-gen\ndescription: Controlled instruction fixture\n---\nGenerate fixture images.\n";
    await fs.writeFile(filePath, content);
    await fs.mkdir(path.join(root, "references"));
    await fs.writeFile(path.join(root, "references", "SKILL.md"), content);
    const definition = { name: "image-gen", filePath, rootPath: root, path: "builtin/image-gen/SKILL.md" };
    const bundle = { skills: [definition], instructions: { [filePath]: content }, paths: [], prompt: "", warnings: [], conflicts: [], errors: [] };
    await action({ root, filePath, content, bundle });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function resolve(tool: ReaderTool, resource: string): Promise<Execution> {
  const execution = await tool.resolveExecution({ skill: "image-gen", path: resource });
  assert.ok("execute" in execution);
  return execution;
}
const executionContext = { toolCallId: "fixture", operationId: "fixture" };

test("only a completed canonical instruction read emits canonical load evidence", async () => {
  await fixture(async ({ bundle, content }) => {
    const tool = reader()(bundle);
    for (const resource of ["SKILL.md", "./SKILL.md", "references/../SKILL.md"]) {
      const result = await (await resolve(tool, resource)).execute(executionContext);
      assert.equal(result.loadedSkill, "image-gen");
      assert.equal(result.content, content);
    }
    const reference = await (await resolve(tool, "references/SKILL.md")).execute(executionContext);
    assert.equal(reference.content, content);
    assert.ok(!Object.hasOwn(reference, "loadedSkill"), "even identical resource contents are not the canonical skill file");
  });
});

test("empty canonical files and metadata discovery cannot claim a load", async () => {
  await fixture(async ({ bundle, filePath }) => {
    const tool = reader()(bundle);
    assert.ok(!Object.hasOwn(bundle.skills[0]!, "loadedSkill"));
    await fs.writeFile(filePath, " \n\t");
    const result = await (await resolve(tool, "SKILL.md")).execute(executionContext);
    assert.ok(!Object.hasOwn(result, "loadedSkill"));
  });
});

test("missing, escaped, denied, changed, binary, oversized and cancelled reads never return load evidence", async () => {
  await fixture(async ({ bundle, filePath }) => {
    const tool = reader()(bundle);
    for (const resource of ["missing.md", "../outside.md"]) {
      const failed = await tool.resolveExecution({ skill: "image-gen", path: resource });
      assert.ok("isError" in failed);
      assert.equal(failed.isError, true);
      assert.ok(!Object.hasOwn(failed, "loadedSkill"));
    }
    const cancelled = await resolve(tool, "SKILL.md");
    await assert.rejects(() => cancelled.execute({ ...executionContext, signal: AbortSignal.abort(new Error("cancelled fixture")) }), /cancelled fixture/u);
    const deniedFs = { ...fs, open: async () => { throw Object.assign(new Error("permission denied fixture"), { code: "EACCES" }); } };
    const denied = await resolve(reader(deniedFs)(bundle), "SKILL.md");
    await assert.rejects(() => denied.execute(executionContext), /permission denied fixture/u);
    const changed = await resolve(tool, "SKILL.md");
    await fs.writeFile(filePath, "Changed after validation");
    await assert.rejects(() => changed.execute(executionContext), /changed/u);
    await fs.writeFile(filePath, "binary\0instruction");
    const binary = await resolve(tool, "SKILL.md");
    await assert.rejects(() => binary.execute(executionContext), /binary/u);
    await fs.writeFile(filePath, "x".repeat(1024 * 1024 + 1));
    const oversized = await tool.resolveExecution({ skill: "image-gen", path: "SKILL.md" });
    assert.ok("isError" in oversized);
    assert.equal(oversized.isError, true);
    assert.ok(!Object.hasOwn(oversized, "loadedSkill"));
  });
});

const parsedCoordinator = ts.createSourceFile("coordinator.ts", coordinatorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const coordinatorClass = parsedCoordinator.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ToolExecutionCoordinator");
const outline = coordinatorClass?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(parsedCoordinator) === "outlineToolResultForPersistence");
assert.ok(outline);
checkExtracted(outline);
const outlineSource = `${declarations(coordinatorSource, ["readStringField"])}\nclass Fixture {\n${outline.getText(parsedCoordinator)}\n};`;
interface PersistenceFixture {
  context: { workspaceRoot: string; recorder: { sessionId: string } };
  goalControlCalls: Set<string>;
  outlineToolResultForPersistence(call: { id: string; name: string }, sequence: number, result: unknown, source: string): Promise<Result>;
}
function persistence(archiveFails = false) {
  const Fixture = compileFunction(stripTypeScriptTypes(outlineSource) + "\nreturn Fixture;", ["serializeToolResult", "toolResultPreview", "readResultLineRange",
    "archiveToolResult", "formatToolError", "inlineResultPersistMaxBytes", "maxArchivedPreviewCharacters"])(
    JSON.stringify, (text: string, size: number) => text.slice(0, size), () => undefined,
    async () => { if (archiveFails) throw new Error("archive fixture failure"); return { archivePath: ".biny/tool-results/fixture.json" }; },
    (_name: string, error: Error) => error.message, 32 * 1024, 8192) as new () => PersistenceFixture;
  const instance = new Fixture();
  instance.context = { workspaceRoot: "/controlled-fixture", recorder: { sessionId: "fixture" } };
  instance.goalControlCalls = new Set();
  return (result: unknown, tool = "read_skill_resource", source = "skill") => instance.outlineToolResultForPersistence({ id: "fixture", name: tool }, 1, result, source);
}

test("large successful instruction reads retain evidence through archive success and failure", async () => {
  await fixture(async ({ bundle, filePath }) => {
    await fs.writeFile(filePath, "Instruction body.\n".repeat(3000));
    const result = await (await resolve(reader()(bundle), "SKILL.md")).execute(executionContext);
    for (const fail of [false, true]) {
      const archived = await persistence(fail)(result);
      assert.equal(archived.archived, true);
      assert.equal(archived.loadedSkill, "image-gen");
      if (fail) { assert.equal(archived.archiveError, "archive fixture failure"); assert.deepEqual(archived.result, result); }
      else assert.equal(archived.archivePath, ".biny/tool-results/fixture.json");
    }
  });
});

test("archive envelopes do not promote ordinary resources, mismatches or foreign tool markers", async () => {
  const result = { skill: "image-gen", loadedSkill: "image-gen", content: "x".repeat(40000) };
  for (const fail of [false, true]) {
    const outlineResult = persistence(fail);
    for (const [tool, source] of [["Read", "builtin"], ["Bash", "builtin"], ["run_script", "builtin"], ["read_skill_resource", "plugin"], ["read_skill_resource", "mcp"]] as const) {
      assert.ok(!Object.hasOwn(await outlineResult(result, tool, source), "loadedSkill"));
    }
    for (const invalid of [{ skill: "image-gen", content: result.content }, { ...result, skill: "other" },
      { ...result, loadedSkill: "" }, { ...result, loadedSkill: "../image-gen" },
      { ...result, loadedSkill: "x".repeat(65), skill: "x".repeat(65) }]) {
      assert.ok(!Object.hasOwn(await outlineResult(invalid), "loadedSkill"));
    }
  }
});

test("canonical Skill bodies survive ordinary, hook and failed archive envelopes", async () => {
  const body = "# Skill: image-gen\n\n**Skill Directory:** `/controlled/image-gen`\n\n" + "Instruction.\n".repeat(4000)
    + "Follow the instructions above for your response. Remember to use absolute paths when accessing files in the skill directory.";
  for (const fail of [false, true]) {
    const outlineResult = persistence(fail);
    for (const result of [body, { result: body, durationMs: 1 }, { result: body, durationMs: -1, hooks: [] }]) {
      const archived = await outlineResult(result, "Skill", "skill");
      assert.equal(archived.loadedSkill, "image-gen");
      assert.equal(archived.archived, true);
      if (fail) assert.equal(archived.archiveError, "archive fixture failure");
    }
    for (const result of [{ result: body }, { result: { result: body }, durationMs: 1 },
      { result: body, durationMs: NaN }, { result: body, durationMs: 1, hooks: "not an array" },
      body.replace("# Skill: image-gen", "# Skill: ../image-gen"), body.replace("# Skill: image-gen", "# Skill: " + "x".repeat(65)),
      body.replace("**Skill Directory:**", "Directory:"), body.slice(0, -1)]) {
      assert.ok(!Object.hasOwn(await outlineResult(result, "Skill", "skill"), "loadedSkill"));
    }
    for (const source of ["plugin", "mcp", "builtin"]) {
      assert.ok(!Object.hasOwn(await outlineResult(body, "Skill", source), "loadedSkill"));
    }
  }
});
