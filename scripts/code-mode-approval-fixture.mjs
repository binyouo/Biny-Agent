/** Shared source/compiled-artifact probe; application dependencies are supplied by the caller. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { mock } from "node:test";
import { clearTimeout as clearWatchdog, setTimeout as startWatchdog } from "node:timers";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

export async function exerciseCodeModeApprovalGate({ workspace, policy, idPrefix,
  ToolExecutionCoordinator, defaultConfig, PermissionManager, SessionRecorder, ensureAgentDirs, ToolRegistry, z }) {
  await mkdir(workspace, { recursive: true });
  await ensureAgentDirs(workspace);
  const recorder = new SessionRecorder(workspace, `${idPrefix}-approval`);
  const registry = new ToolRegistry();
  let calls = 0;
  let approvals = 0;
  let resolutions = 0;
  let preparation;
  registry.register({ name: "search_history", description: "Fixture history", risk: "read", capability: "memory.read",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    schema: z.object({ query: z.string() }), async resolveExecution() {
      resolutions++;
      if (preparation) { preparation.entered.resolve(); await preparation.release.promise; }
      return { approvalRule: "search_history", execute: async () => { calls++; return { hits: [] }; } };
    } });
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "code_mode";
  config.permission.mode = "ask";
  config.permission.allowTools = [];
  const coordinator = confirm => new ToolExecutionCoordinator({ workspaceRoot: workspace, config, recorder, toolRegistry: registry,
    confirmPermission: async () => { approvals++; return await confirm(); } },
  new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["search_history"]));
  const assertAuditOnce = async id => {
    await recorder.flush();
    const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const child = `${id}:nested:1`;
    const childCalls = events.filter(event => event.type === "tool_call" && event.toolCallId === child);
    const childResults = events.filter(event => event.type === "tool_result" && event.toolCallId === child);
    assert.equal(childCalls.length, 1);
    assert.equal(childResults.length, 1);
    assert.equal(childCalls[0].auditOnly, true);
    assert.equal(childResults[0].auditOnly, true);
    assert.equal(events.filter(event => event.type === "tool_call" && event.toolCallId?.startsWith(`${id}:nested:`)).length, 1,
      "A deadline must not admit or replay another child");
  };
  try {
    const approved = coordinator(async () => { await delay(250); return { approved: true, scope: "once" }; });
    const approvedId = `${idPrefix}-approved`;
    const result = await approved.createCodeModeTool(undefined, policy).execute(approvedId, {
      code: "return (await tools.search_history({query:'fixture'})).hits.length;" });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    assert.equal(result.details.value, 0);
    assert.equal(approvals, 1);
    assert.equal(calls, 1);
    await approved.waitForIdle();
    await assertAuditOnce(approvedId);

    // Freeze only host-side timers so disk/scheduler latency cannot decide which
    // approval stage is reached. Both cases expire the original 150ms budget.
    for (const beforePermission of [true, false]) {
      const entered = deferred();
      const release = deferred();
      const late = coordinator(async () => {
        entered.resolve();
        await release.promise;
        return { approved: true, scope: "once" };
      });
      const id = `${idPrefix}-${beforePermission ? "pre-admission" : "late-approval"}-deadline`;
      preparation = beforePermission ? { entered, release } : undefined;
      mock.timers.enable({ apis: ["setTimeout"] });
      const pending = late.createCodeModeTool(undefined, { ...policy, hostCallTimeoutMs: 150 }).execute(id, {
        code: "try { await tools.search_history({query:'late'}); } catch {} return await tools.search_history({query:'replay'});" });
      try {
        await bounded(Promise.race([entered.promise, pending.then(value => {
          assert.fail(`Cell ended before the expected ${beforePermission ? "preparation" : "permission"} entry: ${JSON.stringify(value.details)}`);
        })]));
        assert.equal(approvals, beforePermission ? 1 : 2, "The intended approval stage must be observed before expiration");
        mock.timers.tick(150);
        // Preparation must settle after cancellation before its coordinator can
        // finish; permission remains held until the cancelled cell has ended.
        if (beforePermission) release.resolve();
        const timedOut = await bounded(pending);
        assert.equal(timedOut.isError, true);
        assert.match(timedOut.details.error, /150ms host\/approval deadline/u);
        assert.equal(timedOut.details.outcomeUnknown, undefined);
        assert.equal(timedOut.details.childCalls.length, 1);
        release.resolve();
        await nextTurn(); // Drain the late approval's abort check, without sleeping.
        await bounded(late.waitForIdle());
        assert.equal(approvals, beforePermission ? 1 : 2);
        assert.equal(calls, 1, "Late permission cannot dispatch the cancelled child");
        assert.equal(resolutions, beforePermission ? 2 : 3, "The cancelled cell cannot replay resolution");
        await assertAuditOnce(id);
      } finally {
        release.resolve();
        mock.timers.reset();
        await bounded(pending);
        await bounded(late.waitForIdle());
        preparation = undefined;
      }
    }
  } finally { await recorder.close(); }
}

// A real watchdog diagnoses a broken entry gate even while production timers
// are frozen; it never drives the behavior being asserted.
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = startWatchdog(() => reject(new Error("Approval fixture did not reach or settle its explicit gate")), 5_000);
    })]);
  } finally { clearWatchdog(timer); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
