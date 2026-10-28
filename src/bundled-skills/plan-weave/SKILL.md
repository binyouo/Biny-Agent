---
name: plan-weave
description: "Plan and run multi-stage work as a persistent dependency graph. Use for migrations, investigations, or feature work with prerequisites, independent branches, and pause or recovery needs. Use todo for a short checklist and tasks for one independently tracked execution."
allowed-tools:
  - Bash
---

# Plan Weave Skill

Run long, multi-step work as a **persistent task graph**. Use this for migrations, large features, investigations, and work with independently verifiable stages. For a short checklist use `todo`; for one independently tracked worker use `tasks`.

Run commands from the intended workspace. The Runtime Host stores the graph and its execution records; a plan is not proof that its work ran.

## Create a graph

Define each node by an independently verifiable outcome. `nodeKey` must be unique, `prompt` must be nonempty, and `dependencies` must name other nodes in the same graph. Self-dependencies and cycles are rejected.

This example expresses inspection, implementation, and verification in sequence. Replace the prompts with the actual request, constraints, and acceptance criteria before creating it:

```bash
biny graph create --nodes '[
  {"nodeKey":"inspect","prompt":"Locate the reported failure and reproduce it without modifying unrelated work."},
  {"nodeKey":"implement","prompt":"Fix the reproduced failure and add focused regression coverage.","dependencies":["inspect"]},
  {"nodeKey":"verify","prompt":"Review the change against the request, run affected checks, and report evidence and remaining limitations.","dependencies":["implement"]}
]' --json
```

Model actual prerequisites. Independent branches can share an upstream dependency; coupled edits need an explicit order. Include acceptance criteria in each prompt, and use the optional `verification` field only with a supported deterministic verification contract. A node named `verify` is ordinary work, not an approval gate or automatic proof of correctness.

Graph creation does not create a separate persistent goal. Only when the user explicitly requests goal tracking, use `biny goal set "<objective>" --session <sessionId> --json`; do not infer that request from a large task.

### Authoring Quality

- Split tasks by data flow, contract boundary, or independently verifiable acceptance — merge tiny tasks that can't be executed or verified on their own
- Every key requirement of the goal must map to a node or acceptance item
- Node `prompt` must be scoped and verifiable; state what NOT to touch when it matters
- Put a review node after any work where "plausible but wrong" is likely (schema changes, contracts, security-sensitive paths)
- Model the real execution order with `dependencies`; don't fake parallelism between coupled tasks
- Reject fake completion: schema with no runtime use, API with no caller, config never read, fixture-only testing

A review node is an ordinary graph step. Biny does not implement claim/submit/review-cycle commands here. If review discovers missing work, pause the graph and resolve the actual blocked outcome before progressing; never treat a review label as an approval gate.

## Start and inspect

Use the `graphId` returned by creation or listing:

```bash
biny graph list --json
biny graph start <graphId> --json
biny graph inspect <graphId> --json
biny graph events <graphId> --limit 100 --json
biny graph events <graphId> --cursor <nextCursor> --limit 100 --json
```

Events default to 100 per page, with a maximum of 1000. Follow the returned `nextCursor` while `hasMore` is true. Inspect node states and their returned `taskRunId`; use `biny task get` and `biny task events` for execution evidence. The runtime creates and associates node TaskRuns. Do not create a detached duplicate task or invent a CLI command to bind one.

An accepted start request does not prove dispatch or completion. If the execution adapter is unavailable or a transition is rejected, report the returned state and reason.

## Pause and recover

```bash
biny graph pause <graphId> --json
biny graph resume <graphId> --json
biny graph cancel <graphId> --json
```

After an interruption, inspect persisted state before resuming. Preserve failed or blocked nodes and their evidence; do not report downstream work as complete when its prerequisite failed. Pause when an upstream outcome needs clarification, and resume within the existing authorization once the blocker is resolved. Cancellation is not rollback of already completed effects.

Report meaningful progress through the graph, then finish with verified outcomes and remaining blockers. Graph instructions cannot grant approval, tools, concurrency, or permission to delegate.
