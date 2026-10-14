/** Pure point-read regression: execute only the AST-selected sessions method with memory fakes.
 * This does not execute public resolve, visibility, filesystem security checks, or product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("src/session/localReferences.ts", "utf8");
const parsed = ts.createSourceFile("localReferences.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const service = parsed.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "LocalReferenceService");
assert.ok(service);
const methods = service.members.filter(ts.isMethodDeclaration);
const sessions = methods.find((node) => node.name.getText(parsed) === "sessions");
assert.ok(sessions);
const baselineMethod = "private async sessions(project: LocalReferenceProject): Promise<Array<{ id: string; events: SessionEvent[] }>> {\n    const rows: Array<{ id: string; events: SessionEvent[] }> = [];\n    for (const { id, file } of await this.sessionFiles(project)) {\n      const events: SessionEvent[] = [];\n      for (const line of (await readFile(file, \"utf8\")).split(\"\\n\")) {\n        if (!line.trim()) continue;\n        try { events.push(JSON.parse(line) as SessionEvent); } catch { break; }\n      }\n      rows.push({ id, events });\n    }\n    return rows;\n  }";
const candidateMethod = "private async sessions(project: LocalReferenceProject, threadId?: string): Promise<Array<{ id: string; events: SessionEvent[] }>> {\n    const rows: Array<{ id: string; events: SessionEvent[] }> = [];\n    for (const { id, file } of await this.sessionFiles(project)) {\n      if (threadId !== undefined && id !== threadId) continue;\n      const events: SessionEvent[] = [];\n      for (const line of (await readFile(file, \"utf8\")).split(\"\\n\")) {\n        if (!line.trim()) continue;\n        try { events.push(JSON.parse(line) as SessionEvent); } catch { break; }\n      }\n      rows.push({ id, events });\n    }\n    return rows;\n  }";
assert.ok([baselineMethod, candidateMethod].includes(sessions.getText(parsed)), "execute only an exact reviewed method");
const methodText = sessions.getText(parsed).replace(/^private async sessions/u, "async function sessions");
const compiled = ts.transpileModule(methodText + "\nsessions;", {
  fileName: "isolated-sessions.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, strict: true }
});
assert.equal((compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);

type Entry = { id: string; file: string };
type Event = { type: string; content?: string; toolCallId?: string; [key: string]: unknown };
type Row = { id: string; events: Event[] };
type Sessions = (this: { sessionFiles(project: object): Promise<Entry[]> }, project: object, threadId?: string) => Promise<Row[]>;
const project = Object.freeze({ id: "project-one", path: "/synthetic/project-one", name: "Synthetic" });
function harness(entries: Entry[], files: Map<string, string | Error>, enumerationError?: Error) {
  const calls: string[] = [];
  let parses = 0;
  let enumerations = 0;
  let currentEntries = entries;
  const parse = (line: string): unknown => {
    assert.equal(typeof line, "string");
    assert.ok([...files.values()].some((text) => typeof text === "string" && text.split("\n").includes(line)),
      "JSON parsing is limited to synthetic in-memory file lines");
    parses += 1;
    return JSON.parse(line);
  };
  const run = runInNewContext(compiled.outputText, {
    readFile: async (file: string, encoding: string): Promise<string> => {
      assert.equal(encoding, "utf8");
      assert.ok(files.has(file), "only synthetic file names are readable");
      calls.push(file);
      const value = files.get(file)!;
      if (value instanceof Error) throw value;
      return value;
    },
    JSON: Object.freeze({ parse })
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as Sessions;
  const receiver = {
    sessionFiles: async (requested: object): Promise<Entry[]> => {
      assert.equal(requested, project);
      enumerations += 1;
      if (enumerationError) throw enumerationError;
      return currentEntries.map((entry) => ({ ...entry }));
    }
  };
  return {
    read: (threadId?: string) => run.call(receiver, project, threadId),
    calls,
    parses: () => parses,
    enumerations: () => enumerations,
    setEntries: (next: Entry[]) => { currentEntries = next; }
  };
}
const line = (content: string): string => JSON.stringify({ type: "user_message", content });
const text = (content: string): string => line(content) + "\n";
const failures: string[] = [];
let passed = 0;
async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try { await test(); passed += 1; console.log("PASS " + name); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(name + ": " + detail);
    console.log("FAIL " + name + ": " + detail);
  }
}
async function main(): Promise<void> {
  await check("targeted 100-file read parses only the selected four lines", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: "thread-" + String(index).padStart(3, "0"), file: "/synthetic/" + String(index).padStart(3, "0") + ".jsonl"
    }));
    const files = new Map(entries.map((entry) => [entry.file, Array.from({ length: 4 }, (_, index) =>
      JSON.stringify({ type: "tool_call", tool: "Read", toolCallId: entry.id + "-call-" + index, args: {} })).join("\n") + "\n"]));
    const fake = harness(entries, files);
    const rows = await fake.read("thread-057");
    assert.equal(fake.enumerations(), 1);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0], "/synthetic/057.jsonl");
    assert.equal(fake.parses(), 4);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.events.length, 4);
    assert.equal(rows[0]?.events[0]?.toolCallId, "thread-057-call-0");
  });
  await check("no filter retains whole-project reads and event contents", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ id: "t" + index, file: "/synthetic/f" + index }));
    const files = new Map(entries.map((entry) => [entry.file, text(entry.id)]));
    const fake = harness(entries, files);
    const rows = await fake.read();
    assert.equal(fake.calls.length, 100);
    assert.equal(fake.parses(), 100);
    assert.equal(rows.length, 100);
    assert.equal(rows[99]?.events[0]?.content, "t99");
  });
  await check("missing target reads no file after enumeration", async () => {
    const fake = harness([{ id: "other", file: "/synthetic/other" }], new Map([["/synthetic/other", text("other")]]));
    assert.equal((await fake.read("missing")).length, 0);
    assert.equal(fake.enumerations(), 1);
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.parses(), 0);
  });
  await check("duplicate target IDs retain sorted first-match and read every matching file", async () => {
    const entries = [
      { id: "same", file: "/synthetic/a/same.jsonl" },
      { id: "other", file: "/synthetic/b/other.jsonl" },
      { id: "same", file: "/synthetic/c/same.jsonl" }
    ];
    const files = new Map(entries.map((entry) => [entry.file, text(entry.file)]));
    const fake = harness(entries, files);
    const rows = await fake.read("same");
    assert.equal(JSON.stringify(fake.calls), JSON.stringify([entries[0]!.file, entries[2]!.file]));
    assert.equal(rows.length, 2);
    // This find models only the existing caller's selection, not public resolve.
    assert.equal(rows.find((row) => row.id === "same")?.events[0]?.content, entries[0]!.file);
    assert.equal(fake.parses(), 2);
  });
  await check("later same-ID read error still propagates", async () => {
    const expected = new Error("later matching read failed");
    const fake = harness([{ id: "same", file: "/synthetic/a" }, { id: "same", file: "/synthetic/b" }],
      new Map<string, string | Error>([["/synthetic/a", text("first")], ["/synthetic/b", expected]]));
    await assert.rejects(fake.read("same"), (error: unknown) => error === expected);
    assert.equal(fake.calls.length, 2);
  });
  await check("target read error still propagates", async () => {
    const expected = new Error("target read failed");
    const fake = harness([{ id: "target", file: "/synthetic/target" }], new Map([["/synthetic/target", expected]]));
    await assert.rejects(fake.read("target"), (error: unknown) => error === expected);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.parses(), 0);
  });
  await check("unrelated content-read error cannot block a valid target", async () => {
    const fake = harness([{ id: "other", file: "/synthetic/other" }, { id: "target", file: "/synthetic/target" }],
      new Map<string, string | Error>([["/synthetic/other", new Error("unrelated unreadable bytes")], ["/synthetic/target", text("target")]]));
    assert.equal((await fake.read("target"))[0]?.events[0]?.content, "target");
    assert.equal(JSON.stringify(fake.calls), JSON.stringify(["/synthetic/target"]));
  });
  await check("enumeration error still propagates before any read", async () => {
    const expected = new Error("enumeration validation failed");
    const fake = harness([], new Map(), expected);
    await assert.rejects(fake.read("target"), (error: unknown) => error === expected);
    assert.equal(fake.enumerations(), 1);
    assert.equal(fake.calls.length, 0);
  });
  await check("same harness rereads edits and re-enumerates deletion without caching", async () => {
    const entry = { id: "target", file: "/synthetic/target" };
    const files = new Map([[entry.file, text("first")]]);
    const fake = harness([entry], files);
    assert.equal((await fake.read("target"))[0]?.events[0]?.content, "first");
    files.set(entry.file, text("edited"));
    assert.equal((await fake.read("target"))[0]?.events[0]?.content, "edited");
    fake.setEntries([]);
    files.delete(entry.file);
    assert.equal((await fake.read("target")).length, 0);
    assert.equal(fake.enumerations(), 3);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.parses(), 2);
  });
  await check("blank lines and malformed tail keep existing prefix parsing behavior", async () => {
    const bytes = "\n " + "\n" + line("one") + "\n" + line("two") + "\n{partial\n" + line("must not parse") + "\n";
    const fake = harness([{ id: "target", file: "/synthetic/target" }], new Map([["/synthetic/target", bytes]]));
    const rows = await fake.read("target");
    assert.equal(JSON.stringify(rows[0]?.events.map((event) => event.content)), JSON.stringify(["one", "two"]));
    assert.equal(fake.parses(), 3);
  });
  await check("AST caller contract narrows only resolve; search and allMessages remain full scans", () => {
    const found: Array<{ method: string; args: string[] }> = [];
    for (const method of methods) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "sessions") {
          found.push({ method: method.name.getText(parsed), args: node.arguments.map((arg) => arg.getText(parsed)) });
        }
        ts.forEachChild(node, visit);
      };
      visit(method);
    }
    assert.equal(JSON.stringify(found), JSON.stringify([
      { method: "resolve", args: ["project", "threadId"] },
      { method: "search", args: ["project"] },
      { method: "allMessages", args: ["project"] }
    ]));
  });
  console.log("Pure sessions fixture: " + passed + " passed, " + failures.length + " failed.");
  assert.equal(failures.length, 0, failures.join("\n"));
}
main();
