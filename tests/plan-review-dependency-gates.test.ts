import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

// Actual plan tools, schemas, projection and graph mutation/readiness methods.
// Only persistence/event delivery and task-contract reading are inert seams;
// fixtures supply already-valid contracts. No Host, Worker, SQLite or shell.
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
function compile(source: string, environment: Record<string, any> = {}) {
  const exports: Record<string, any> = {};
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics, []);
  vm.runInNewContext(result.outputText, { exports, ...environment });
  return exports;
}
function declarations(source: string, names: string[], kind: "function" | "method" | "variable") {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const members = kind === "method" ? file.statements.filter(ts.isClassDeclaration).find(node => node.name?.text === "GoalGraphStore")!.members : file.statements;
  return names.map(name => {
    const matches = members.filter(node => {
      if (kind === "variable") return ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(file) === name);
      if (kind === "method") return ts.isMethodDeclaration(node) && node.name.getText(file) === name;
      return ts.isFunctionDeclaration(node) && node.name?.getText(file) === name;
    });
    assert.equal(matches.length, 1, name); return matches[0]!.getText(file);
  }).join("\n");
}
const readTaskDefinition = (intent: any) => ({ prompt: intent.prompt, verification: intent.verification });
const verification = { readTaskDefinition, pendingTaskVerificationApproval: () => undefined };
const work = compile(read("runtime/planWork.ts"), { require: (id: string) => {
  if (id === "zod") return { z };
  assert.equal(id, "./taskVerification.js"); return verification;
} });
const schema = compile(declarations(read("extensions/subagent.ts"), ["taskVerificationSchema"], "variable"), { z }).taskVerificationSchema;
const imports: Record<string, any> = {
  zod: { z }, "../runtime/taskVerification.js": verification,
  "../tools/access.js": { ToolAccesses: { none: () => [] } },
  "./subagent.js": { taskVerificationSchema: schema }, "../runtime/planWork.js": work
};
const plan = compile(read("extensions/plan.ts"), { require: (id: string) => { assert.ok(Object.hasOwn(imports, id), id); return imports[id]; } });
const graphSource = read("runtime/GoalGraphStore.ts");
const helpers = declarations(graphSource, ["nodeInputFromRecord", "validateGraphNodes", "currentGraphNodes", "dependencyCompleted", "stringify"], "function");
const methods = declarations(graphSource, ["replaceSupervisedNode", "reworkSupervisedNode", "addSupervisedNodes", "readyNodes", "requireSupervisedGraph", "assertReplanAvailable"], "method");
let nextId = 0;
const graphPrototype = compile(`${helpers}\nexport class Fixture {${methods}}`, {
  readTaskDefinition, planBlock: work.planBlock, latestPlanNode: work.latestPlanNode,
  planReviewResultSchema: work.planReviewResultSchema, randomUUID: () => `node-${++nextId}`
}).Fixture.prototype;
const verificationInput = { objective: "Correct result", checks: [{ command: "inert-check" }], artifactPaths: ["result.txt"] };
const contract = schema.parse(verificationInput);
const task = (key: string, extra: Record<string, any> = {}) => ({ key, title: "Same display title", task: `Implement ${key}`, acceptance: ["Correct result"], verification: contract, ...extra });
function fixture(reviewed = true) {
  const initial = work.planTasksToNodes([task("a", reviewed ? { review: "Review A" } : {}), task("b", { dependencies: ["a"] })]);
  const graph = { graphId: "g", mode: "supervised", supervisorSessionId: "s", status: "running", revision: 0, payload: {}, replanCount: 0, maxReplans: 2,
    nodes: initial.map((node: any) => ({ ...node, dependencies: node.dependencies ?? [], nodeId: node.nodeKey, status: "pending", revision: 0 })) };
  const wakes: string[] = []; let checkpointRefreshes = 0;
  const store = Object.assign(Object.create(graphPrototype), {
    requireGraph: () => graph, inspectGraph: () => graph,
    withGraphEvent: (_event: unknown, commit: () => unknown) => commit(),
    queueCurrentSupervisorCheckpoint: () => { checkpointRefreshes++; },
    supervisorCheckpoint: () => undefined, createWake: (_graphId: string, reason: string) => wakes.push(reason),
    database: { prepare(sql: string) {
      if (sql.startsWith("INSERT INTO graph_nodes")) return { run(id: string, _graphId: string, key: string, dependencies: string, intent: string, replaces?: string) {
        graph.nodes.push({ nodeId: id, nodeKey: key, status: "pending", revision: 0, dependencies: JSON.parse(dependencies), intent: JSON.parse(intent), ...(replaces ? { replacesNodeId: replaces } : {}) });
      } };
      if (sql.startsWith("UPDATE graphs SET replan_count")) return { run() { graph.replanCount++; graph.revision++; } };
      throw Error(`Unexpected SQL: ${sql}`);
    } }
  });
  const admissionDependencies: string[][] = [];
  const addSupervisedNodes = store.addSupervisedNodes.bind(store);
  store.addSupervisedNodes = (graphId: string, sessionId: string, nodes: any[]) => {
    admissionDependencies.push(...nodes.map(node => Array.from(node.dependencies ?? []) as string[]));
    return addSupervisedNodes(graphId, sessionId, nodes);
  };
  const tools = plan.createPlanTools({ graphs: store, taskRuns: { get: () => undefined } });
  const context = { sessionId: "s", runId: "run", toolCallId: "tool" };
  const call = async (name: string, input: any) => {
    const tool = tools.find((entry: any) => entry.name === name);
    return await (await tool.resolveExecution(tool.schema.parse(input))).execute(context);
  };
  const node = (key: string) => { const found = graph.nodes.find((entry: any) => entry.nodeKey === key); assert.ok(found, key); return found; };
  const replace = (old = "a", key = "a2") => { node(old).status = "failed"; store.replaceSupervisedNode("g", "s", node(old).nodeId, { nodeKey: key, prompt: `Retry ${old}` }); node(key).status = "completed"; return key; };
  const rework = (reviewKey = "a:review") => {
    node("a").status = "completed";
    const review = node(reviewKey); review.status = "blocked";
    review.artifact = { review: { verdict: "needs_changes", summary: "Repair", evidenceReferences: ["result.txt"], findings: [{ criterion: "Correct result", requestedChange: "Fix it" }] } };
    const before = graph.nodes.length; store.reworkSupervisedNode("g", "s", review.nodeId);
    const repair = graph.nodes[before]!; repair.status = "completed";
    return { repair: repair.nodeKey, review: graph.nodes[before + 1]!.nodeKey };
  };
  const add = async (dependency: string, key = "downstream", extra: any[] = []) => {
    await call("PlanStatus", { graphId: "g" });
    await call("PlanUpdate", { action: "add", graphId: "g", nodes: [{ key, task: "Consume reviewed result", acceptance: ["Correct"], dependencies: [dependency] }, ...extra] });
    return node(key);
  };
  return { graph, store, node, replace, rework, add, call, wakes, admissionDependencies, checkpointRefreshes: () => checkpointRefreshes,
    ready: () => Array.from(store.readyNodes("g"), (entry: any) => entry.nodeKey) };
}

for (const evolution of ["replace", "rework"] as const) for (const state of ["pending", "running", "blocked", "failed", "cancelled", "completed"] as const) {
  test(`${evolution} alias waits for ${state} review`, async () => {
    const f = fixture();
    const evolved = evolution === "replace" ? { repair: f.replace(), review: "a:review" } : f.rework();
    f.node(evolved.review).status = state;
    const added = await f.add(evolved.repair);
    assert.equal(added.dependencies[0], evolved.review);
    assert.equal(f.ready().includes("downstream"), state === "completed");
    assert.equal(f.graph.replanCount, 2);
    assert.equal(f.checkpointRefreshes(), 1, "keep #126 checkpoint refresh");
    assert.deepEqual(f.wakes, ["plan_updated"]);
  });
}

for (const evolution of ["replace", "rework"] as const) {
  test(`${evolution}: review rejection after add never makes downstream runnable`, async () => {
    const f = fixture(), evolved = evolution === "replace" ? { repair: f.replace(), review: "a:review" } : f.rework();
    await f.add(evolved.repair);
    f.node(evolved.review).status = "blocked";
    assert.equal(f.ready().includes("downstream"), false);
    f.node(evolved.review).status = "completed";
    assert.equal(f.ready().includes("downstream"), true);
  });
  test(`${evolution}: original task key keeps its existing gate`, async () => {
    const f = fixture(), gate = evolution === "replace" ? (f.replace(), "a:review") : f.rework().review;
    assert.equal((await f.add("a")).dependencies[0], gate);
  });
}

test("unreviewed replacement remains a direct dependency", async () => {
  const f = fixture(false), alias = f.replace();
  assert.equal((await f.add(alias)).dependencies[0], alias);
  assert.equal(f.ready().includes("downstream"), true);
});

test("review's own dependency stays on implementation; add batch internal dependencies retain new review gate", async () => {
  const f = fixture(), alias = f.replace();
  await f.call("PlanStatus", { graphId: "g" });
  await f.call("PlanUpdate", { action: "add", graphId: "g", nodes: [
    { key: "c", task: "Implement C", verification: verificationInput, review: "Review C", dependencies: [alias] },
    { key: "d", task: "Consume C", acceptance: ["Correct"], dependencies: ["c"] }
  ] });
  assert.deepEqual(Array.from(f.node("c").dependencies), ["a:review"]);
  assert.deepEqual(Array.from(f.node("c:review").dependencies), ["c"]);
  assert.deepEqual(Array.from(f.node("d").dependencies), ["c:review"]);
  assert.deepEqual(Array.from(f.node("a:review").dependencies), ["a"]);
});

test("same display title and unrelated review do not redirect an unreviewed task", async () => {
  const f = fixture(); f.node("b").status = "completed";
  assert.equal((await f.add("b")).dependencies[0], "b");
  assert.equal(f.ready().includes("downstream"), true);
});

test("direct review dependencies are not rewritten", async () => {
  const f = fixture(), evolved = f.rework();
  assert.equal((await f.add(evolved.review)).dependencies[0], evolved.review);
  assert.equal(f.ready().includes("downstream"), false);
});

for (const kind of ["replace", "rework", "mixed"] as const) {
  test(`${kind} history does not bypass the two-replan limit`, async () => {
    const f = fixture();
    let dependency: string;
    if (kind === "replace") { f.replace(); dependency = f.replace("a2", "a3"); }
    else if (kind === "rework") { const first = f.rework(); dependency = f.rework(first.review).repair; }
    else { f.replace(); dependency = f.rework().repair; }
    const before = JSON.stringify(f.graph);
    await assert.rejects(f.add(dependency), /replan limit/);
    // Mapping remains correct for historical aliases, but the actual store must
    // still refuse a third replan: no relaxed budget to manufacture a success.
    const currentReview = f.graph.nodes.filter((node: any) => node.intent.planBlock?.kind === "review").at(-1)!;
    assert.equal(f.admissionDependencies.at(-1)?.[0], currentReview.nodeKey);
    assert.equal(JSON.stringify(f.graph), before);
    assert.equal(f.wakes.length, 0);
  });
}

for (const invalid of ["self", "cycle", "missing", "duplicate"] as const) {
  test(`${invalid} dependencies still reject without mutation`, async () => {
    const f = fixture(); const before = JSON.stringify(f.graph);
    const dependencies = invalid === "self" ? ["new"] : invalid === "missing" ? ["missing"] : invalid === "cycle" ? ["other"] : ["a"];
    const nodes = [{ key: invalid === "duplicate" ? "a" : "new", task: "Report", acceptance: ["Correct"], dependencies },
      ...(invalid === "cycle" ? [{ key: "other", task: "Report", acceptance: ["Correct"], dependencies: ["new"] }] : [])];
    await f.call("PlanStatus", { graphId: "g" });
    await assert.rejects(f.call("PlanUpdate", { action: "add", graphId: "g", nodes }), /itself|cycle|missing|unique/);
    assert.equal(JSON.stringify(f.graph), before);
  });
}
