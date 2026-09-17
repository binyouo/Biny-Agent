/** 从草稿、工作包、评审打回到替代门的持久化行为，不依赖真实模型。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { planBlock, planReviewResultSchema, planTasksToNodes, planWorkPacket } from "../src/runtime/planWork.js";
import type { TaskVerificationContract } from "../src/runtime/taskVerification.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-plan-workflow-"));
const authority = await RuntimeEventAuthority.open(root);
const store = await GoalGraphStore.open(root, authority);
const contract: TaskVerificationContract = { version: 1, objective: "correct file", checks: [{ id: "check", command: "true", definitionPaths: [] }], artifactPaths: ["a.txt"], allowedRepairPaths: ["a.txt"], maxAttempts: 1 };
try {
  const nodes = planTasksToNodes([
    { key: "a", title: "A", task: "implement A", acceptance: ["correct file"], verification: contract, review: "review A" },
    { key: "b", title: "B", task: "consume A", dependencies: ["a"], acceptance: ["correct file"], verification: contract }
  ]);
  const draft = store.createSupervisedGraph({ supervisorSessionId: "session", nodes, payload: { objective: "deliver" } });
  assert.equal(draft.status, "draft");
  assert.deepEqual(store.readyNodes(draft.graphId), []);
  assert.throws(() => store.startSupervisedDraft(draft.graphId, "other", draft.revision), /session/u);
  assert.throws(() => store.startSupervisedDraft(draft.graphId, "session", draft.revision + 1), /revision/u);
  store.startSupervisedDraft(draft.graphId, "session", draft.revision);
  const implementation = store.readyNodes(draft.graphId)[0]!;
  store.claimIntent(draft.graphId, implementation.nodeId);
  store.completeNode(draft.graphId, implementation.nodeId, "completed", { output: "real report", verification: { status: "passed" } });
  const review = store.readyNodes(draft.graphId)[0]!;
  assert.equal(planBlock(review.intent)?.kind, "review");
  assert.match(planWorkPacket(store.inspectGraph(draft.graphId), review), /real report/u);
  assert.deepEqual(store.readyNodes(draft.graphId).map((node) => node.nodeKey), ["a:review"]);
  assert.throws(() => planReviewResultSchema.parse({ verdict: "needs_changes", summary: "bad", evidenceReferences: ["a.txt"], findings: [] }));
  store.claimIntent(draft.graphId, review.nodeId);
  store.completeNode(draft.graphId, review.nodeId, "blocked", { review: { verdict: "needs_changes", summary: "fix A", evidenceReferences: ["a.txt"], findings: [{ criterion: "correct file", requestedChange: "fix it" }] } });
  const repaired = store.reworkSupervisedNode(draft.graphId, "session", review.nodeId);
  assert.equal(repaired.replanCount, 1);
  assert.equal(repaired.nodes.length, 5);
  assert.equal(repaired.nodes.find((node) => node.nodeId === implementation.nodeId)?.status, "completed");
  const repair = store.readyNodes(draft.graphId)[0]!;
  assert.equal(planBlock(repair.intent)?.rework, true);
  assert.deepEqual((repair.intent as { verification: unknown }).verification, contract);
  assert.throws(() => store.reworkSupervisedNode(draft.graphId, "session", review.nodeId), /replacement/u);
  store.claimIntent(draft.graphId, repair.nodeId);
  store.completeNode(draft.graphId, repair.nodeId, "completed", { output: "fixed", verification: { status: "passed" } });
  const rereview = store.readyNodes(draft.graphId)[0]!;
  assert.equal(rereview.replacesNodeId, review.nodeId);
  store.claimIntent(draft.graphId, rereview.nodeId);
  store.completeNode(draft.graphId, rereview.nodeId, "completed", { review: { verdict: "passed" } });
  assert.equal(store.readyNodes(draft.graphId)[0]?.nodeKey, "b");

  const bounded = store.createSupervisedGraph({ supervisorSessionId: "bounded", nodes });
  const edited = store.reviseSupervisedDraft(bounded.graphId, "bounded", bounded.revision, nodes, { objective: "revised draft" });
  assert.throws(() => store.startSupervisedDraft(bounded.graphId, "bounded", bounded.revision), /revision/u);
  store.startSupervisedDraft(bounded.graphId, "bounded", edited.revision);
  for (let round = 0; round < 3; round++) {
    const implementation = store.readyNodes(bounded.graphId)[0]!;
    store.claimIntent(bounded.graphId, implementation.nodeId);
    store.completeNode(bounded.graphId, implementation.nodeId, "completed", { verification: { status: "passed" } });
    const review = store.readyNodes(bounded.graphId)[0]!;
    store.claimIntent(bounded.graphId, review.nodeId);
    store.completeNode(bounded.graphId, review.nodeId, "blocked", { review: { verdict: "needs_changes", summary: "fix", evidenceReferences: ["a.txt"], findings: [{ criterion: "correct file", requestedChange: "fix" }] } });
    if (round < 2) store.reworkSupervisedNode(bounded.graphId, "bounded", review.nodeId);
    else assert.throws(() => store.reworkSupervisedNode(bounded.graphId, "bounded", review.nodeId), /replan limit/u);
  }
  assert.equal(store.inspectGraph(bounded.graphId).nodes.length, 7);
  assert.equal(store.finishSupervisedGraph(bounded.graphId, "bounded", "blocked", "Two repairs did not pass review.").status, "blocked");
  console.log("plan workflow tests passed");
} finally {
  store.close(); authority.close();
  await rm(root, { recursive: true, force: true });
}
