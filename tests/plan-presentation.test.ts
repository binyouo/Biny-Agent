/** 仅验证服务端投影对应的文案，不替代用户的界面视觉与交互验收。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanPanel } from "../src/desktop/renderer/src/components/workspace/PlanPanel.js";
import { planStatus } from "../src/extensions/plan.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { planTasksToNodes } from "../src/runtime/planWork.js";
import { presentPlan, type Plan } from "../src/desktop/renderer/src/components/workspace/planPresentation.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-presentation-"));
const authority = await RuntimeEventAuthority.open(root);
const graphs = await GoalGraphStore.open(root, authority);
const taskRuns = await DurableTaskRunStore.open(root, authority);
try {
  const render = (plans: Plan[], busy = false, sessionId = "session") => renderToStaticMarkup(createElement(PlanPanel, {
    sessionId, planning: false, busy,
    projection: { sessionId: "session", plans },
    onMutation: async () => undefined, onError: () => undefined
  }));
  assert.equal(render([]), "", "no plan must leave no persistent planning control above the composer");
  const graph = graphs.createSupervisedGraph({ supervisorSessionId: "session", nodes: planTasksToNodes([
    { key: "analysis", title: "分析", task: "read inputs", acceptance: ["Cite sources"] },
    { key: "implementation", title: "实现", task: "write output", acceptance: ["Checks pass"], verification: { version: 1, objective: "valid output", checks: [{ id: "test", command: "true", definitionPaths: [] }], artifactPaths: ["output.txt"], allowedRepairPaths: ["output.txt"], maxAttempts: 1 } }
  ]) });
  graphs.startGraph(graph.graphId);
  const snapshot = () => planStatus({ graphs, taskRuns }, graph.graphId, "session");
  assert.equal(render([snapshot()], false, "another-session"), "");
  assert.doesNotMatch(render([snapshot()]), /checkbox|只读规划|计划调整|<pre/u);
  const ready = graphs.readyNodes(graph.graphId);
  for (const node of ready) {
    graphs.claimIntent(graph.graphId, node.nodeId);
    graphs.completeNode(graph.graphId, node.nodeId, "completed", { output: "report" });
    if (node.nodeId === ready[0]!.nodeId) {
      const partial = render([snapshot()]);
      assert.match(partial, /只读分析/u);
      assert.match(partial, /报告已产出（未独立验证）/u);
      assert.match(partial, /aria-expanded="true"/u);
      assert.match(partial, /\(1\/2\)/u);
    }
  }
  const html = render([snapshot()]);
  assert.match(html, /aria-expanded="false"/u, "all settled blocks start collapsed even before supervisor finishes");
  assert.match(html, /\(2\/2\)/u);
  assert.doesNotMatch(html, /biny-plan-content|<pre|<ol/u);

  const contract = { version: 1 as const, objective: "correct output", checks: [{ id: "test", command: "true", definitionPaths: [] }], artifactPaths: ["a.txt"], allowedRepairPaths: ["a.txt"], maxAttempts: 1 };
  const reviewed = graphs.createSupervisedGraph({ supervisorSessionId: "session", payload: { objective: "当前计划" }, nodes: planTasksToNodes([
    { key: "a", title: "任务 A", task: "implement", acceptance: ["correct"], verification: contract, review: "review" },
    { key: "b", title: "任务 B", task: "consume", acceptance: ["cite"], dependencies: ["a"] }
  ]) });
  const status = () => planStatus({ graphs, taskRuns }, reviewed.graphId, "session");
  assert.match(render([status()]), /确认并开始/u);
  assert.equal(presentPlan(status()).tasks.length, 2);
  assert.equal(presentPlan(status()).tasks[0]?.blocks.length, 2);
  assert.match(render([snapshot(), status()]), /当前计划/u);
  assert.match(render([status()]), /先做 a/u);
  graphs.startGraph(reviewed.graphId);
  const first = graphs.readyNodes(reviewed.graphId)[0]!;
  graphs.claimIntent(reviewed.graphId, first.nodeId);
  assert.match(render([status()], true), /is-spinning/u);
  assert.doesNotMatch(render([status()], false), /is-spinning/u);
  const approvalSnapshot = status();
  approvalSnapshot.nodes[0]!.taskStatus = "needs_approval";
  assert.equal(presentPlan(approvalSnapshot).tasks[0]?.blocks[0]?.status, "blocked");
  assert.doesNotMatch(render([approvalSnapshot], true), /is-spinning/u);
  graphs.completeNode(reviewed.graphId, first.nodeId, "completed", { verification: { status: "passed" } });
  const review = graphs.readyNodes(reviewed.graphId)[0]!;
  graphs.claimIntent(reviewed.graphId, review.nodeId);
  graphs.completeNode(reviewed.graphId, review.nodeId, "blocked", { review: { verdict: "needs_changes", summary: "fix", evidenceReferences: ["a.txt"], findings: [{ criterion: "correct", requestedChange: "fix" }] } });
  assert.match(render([status()]), /评审 a:review 要求返工/u);
  assert.match(render([status()]), /验收已通过/u);
  graphs.reworkSupervisedNode(reviewed.graphId, "session", review.nodeId);
  const rework = presentPlan(status());
  assert.equal(rework.total, 4, "replaced review history does not inflate visible progress");
  assert.equal(rework.feedback?.nodeId, review.nodeId, "feedback remains while its repair is unresolved");
  assert.ok(!rework.tasks.flatMap((task) => task.blocks).some((block) => block.node.nodeId === review.nodeId));
  assert.match(render([status()]), /1\/2/u, "review counter uses the existing shared replan budget");
  const repair = graphs.readyNodes(reviewed.graphId)[0]!;
  graphs.claimIntent(reviewed.graphId, repair.nodeId);
  graphs.completeNode(reviewed.graphId, repair.nodeId, "completed", { verification: { status: "passed" } });
  assert.equal(presentPlan(status()).feedback, undefined);
  console.log("plan presentation tests passed");
} finally {
  graphs.close(); taskRuns.close(); authority.close();
  await rm(root, { recursive: true, force: true });
}
