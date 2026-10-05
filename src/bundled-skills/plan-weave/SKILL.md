---
name: plan-weave
description: "Turn a large objective into a persistent, dependency-aware GoalGraph with clear task nodes, checkpoints, review gates, and recoverable progress. Use this for multi-stage work with three or more meaningful steps, prerequisites, independent branches, implementation and review phases, pause/resume needs, or failure recovery; triggers include: make a plan, break this into tasks, coordinate phases, build a dependency graph, plan implementation and review, 制定计划, 拆解任务, and 有依赖的多阶段工作. Use `biny graph` for the plan and `biny task` for independently tracked execution; do not use this for a small linear checklist, and never report graph creation as task completion."
---

# Plan Weave Skill

Run long, multi-step work as a **persistent Agent Graph** instead of an ad-hoc todo list. The graph is stored by the Runtime Host, survives the lifetime of the workspace runtime, is inspectable through CLI events, and can coordinate durable TaskRuns without making execution claims that the runtime cannot prove.

The conceptual loop is: **define → validate → start → inspect → recover**. The current CLI exposes graph lifecycle and inspection operations; readiness, dependency enforcement, and task-run creation remain runtime responsibilities rather than prompt-only promises.

## When to use

- Work spanning many steps or sessions, such as migrations, feature work, audits, or investigations, where losing the order midway is a real risk.
- Work with prerequisites, independent branches, explicit acceptance criteria, pause/resume, or review checkpoints.
- Work that needs a durable goal and separately observable execution records.

For a short linear checklist, use the `todo` skill instead. For one independently tracked long-running action without graph dependencies, use the `tasks` skill. This skill is heavier machinery; do not create a graph merely to make a small request look structured.

## 1. Author the graph

Define each node as an independently verifiable unit of value. Give it a stable key, concrete inputs, dependencies, and acceptance evidence. Split work by data flow, contract boundary, or verifiable outcome rather than by arbitrary file count.

```bash
# Create a graph from a JSON node array
biny graph create --nodes '<json>' --json

# Optionally persist the larger objective first
biny goal create "<goal title>" --json
```

Before creating it:

- Map every major requirement to a node or acceptance condition.
- Model real prerequisites; do not create fake parallelism between coupled nodes.
- Add a review/checkpoint node where a result could look plausible while being wrong, especially for contracts, security, data migration, or destructive changes.
- Keep instructions scoped and state what must not be touched when that matters.
- Do not treat a schema, API, configuration, or fixture as complete unless a live consumer or runtime path exists.

## 2. Start and inspect

```bash
# Start the graph
biny graph start <graphId> --json

# List graphs before choosing one to inspect or resume
biny graph list --json

# Inspect graph state and recorded events
biny graph inspect <graphId> --json
biny graph events <graphId> --json
# If hasMore is true, continue using the returned nextCursor
biny graph events <graphId> --cursor <nextCursor> --limit 100 --json
```

Graph events default to 100 per page (maximum 1000). Follow `nextCursor` while `hasMore` is true to inspect later outcomes. Desktop and TUI support the same options: `/graph events <graphId> --cursor <nextCursor> --limit 100`.

Start only an identified graph. Use inspection results to determine which nodes are ready, blocked, running, failed, or complete. Do not claim that a node executed merely because the graph accepted a start request; look for the corresponding TaskRun, tool results, or runtime events.

If a node needs independent execution, create a durable TaskRun with `biny task create "<task>" --json` and relate it to the node using the runtime-supported relationship. Do not write a second task database or infer a relationship that the returned record does not contain.

## 3. Pause, resume, and recover

```bash
biny graph pause <graphId> --json
biny graph resume <graphId> --json
biny graph cancel <graphId> --json
```

Pause the graph when an upstream result is uncertain or an external decision is required. Resume only after inspecting the persisted state and confirming that the blocking condition is resolved. If a graph operation is rejected or its execution adapter is unavailable, report that it was recorded or planned but not executed.

## Rules

- Never start work on a node whose dependencies are not satisfied.
- Treat human approval as an explicit state; do not infer approval from a safe-looking change.
- Preserve failure evidence and prevent affected downstream work from being reported as complete.
- Reviews judge the submitted evidence; they do not silently repair or broaden the implementation.
- Keep the user informed after meaningful graph transitions or review rejection.
- Run commands from the intended workspace so graph and goal state resolve to the correct project.
