---
name: plan-weave
description: "Draft and supervise durable multi-stage plans with dependencies, acceptance criteria, verification, and recovery. Use when work needs dependent execution across turns or restarts; save an unstarted draft when the user asks to plan first. Use todo for an immediate checklist and tasks for one independently tracked execution."
allowed-tools:
  - Bash
---

# Durable Plans

Use a supervised plan for work that needs dependent stages or restart-durable execution. Keep ordinary multi-step work in the current turn. Plan instructions do not grant permission to delegate, change unrelated files, or execute work the user asked only to review.

## Choose drafting or execution

- **Plan first**: use `biny plan draft` to save an unstarted draft. It does not run workers or change workspace files. Revise a draft with its returned `graphId` and current `revision` together.
- **Execute authorized work**: use `biny plan start` with a plan definition, or with a saved draft's actual `graphId` and `revision`. Starting a plan begins execution through the normal permission gate.
- **Supervise**: use `biny plan status` before `biny plan update` or a completion report. The plan belongs to its supervisor session; preserve that session identity.

Run the commands from the intended workspace. They use the owning session’s Runtime Host and its existing permission and execution checks:

```bash
biny plan schema draft --json
biny plan schema start --json
biny plan schema update --json
biny plan status <graphId> --json
```

Foreground commands use the current Agent session. Supply `--session <knownSessionId>` when selecting a particular owning session; do not invent a session or graph ID. `graph create/start` are not available.

## Define verifiable nodes

A definition contains `objective`, optional `constraints`, and two to twenty `nodes`. Review gates also consume graph capacity. Each node uses:

| Field | Meaning |
| --- | --- |
| `key` | Unique task key within the plan |
| `task` | Scoped instructions for this node |
| `title` | Optional short display title |
| `dependencies` | Prerequisite task keys in the same plan; no cycles or self-dependencies |
| `acceptance` | Concrete criteria used to assess the result |
| `verification` | Deterministic checks and artifact/scope contract required for writable work |
| `review` | Optional independent review of a verified candidate; requires `verification` |

Without `verification`, a node is a read-only report with required `acceptance` and no `review` gate. It cannot modify files or run commands. A report must cite its sources and distinguish observation, inference, and uncertainty; it is not independently verified.

Writable nodes require real deterministic verification. Inspect the existing project checks and current schema before supplying `verification`; do not invent a passing command to make a node eligible. Keep implementation and its own validation in one node. Add independent review only when it has a concrete purpose.

Example of an unstarted, read-only investigation draft; replace the source and criteria with the user's actual request:

```bash
biny plan draft --input '{
  "objective":"Understand the reported behavior from local evidence",
  "constraints":["Read only; preserve all workspace files"],
  "nodes":[
    {"key":"inspect","task":"Read the relevant local source and collect references.","acceptance":["Cite the source paths and distinguish confirmed facts from uncertainty"]},
    {"key":"conclude","task":"Compare the upstream report with the request and explain remaining gaps.","acceptance":["Support conclusions with the inspected sources"],"dependencies":["inspect"]}
  ]
}' --json
```

When execution is authorized, start the returned draft using its observed ID and revision as JSON, or supply an authorized definition directly:

```bash
biny plan start --input '<JSON containing the returned graphId and revision>' --json
```

Do not copy a stale revision or start a draft merely because it was saved. Dependencies model prerequisites; the supervised runtime currently executes serially, so independent nodes do not imply parallel workers.

## Inspect progress and evidence

`biny plan status` returns `graphId`, `revision`, checkpoint, node states, associated TaskRun IDs, pending approvals, and evidence references. Inspect it on each supervision wake before changing the plan.

Distinguish `completionBasis: report`, `verification`, and `review`. Read the referenced TaskRun output and verification records before claiming success. A settled graph is a checkpoint; it does not by itself prove the user's objective is complete.

The runtime creates node TaskRuns. Do not create detached duplicates or manually mark workers complete. For the returned TaskRun IDs and graph events:

```bash
biny task get <taskRunId> --json
biny task events <taskRunId> --limit 100 --json
biny graph events <graphId> --limit 100 --json
biny graph events <graphId> --cursor <nextCursor> --limit 100 --json
```

Follow `nextCursor` while `hasMore` is true. Verification approvals require the actual pending approval ID and user authorization for the command; use the `tasks` workflow rather than approving just to unblock progress.

## Review, revise, and finish

`review` creates a read-only gate after a verified implementation candidate. Downstream dependencies wait for that gate. The reviewer inspects evidence and returns a verdict with concrete findings; it does not repair the candidate itself. A node merely named "review" does not create this gate.

After inspecting `biny plan status`, use `biny plan update` with the current graph and actual node IDs:

- `add`: add scoped `nodes` using the same node schema.
- `replace`: replace a node's task with `nodeId`, a new `key`, and `task`; preserve its inherited acceptance and execution constraints.
- `rework`: request changes for a rejected review using that review's actual `nodeId`.
- `stop`: stop the plan, optionally recording a `reason`.
- `finish`: report `outcome: completed|failed|blocked` and a supported `summary` after inspecting the resulting evidence.

For CLI updates, read `biny plan schema update --json` and `plan status` first, then send `--input` with only that action's fields. Manual mutations also require the observed revision via `--revision <revision>`. A stale revision is a reason to inspect again, not overwrite newer state.

Existing graphs can be listed, inspected, paused, resumed, or cancelled:

```bash
biny graph list --json
biny graph inspect <graphId> --json
biny graph pause <graphId> --json
biny graph resume <graphId> --json
biny graph cancel <graphId> --json
```

After interruption, inspect the same plan and its TaskRuns before resuming or retrying. Preserve failed or approval-gated evidence. Cancellation does not undo completed effects, and a draft or accepted start is not proof that the work finished. Keep the Runtime Host's graph and TaskRun records as the execution authority.
