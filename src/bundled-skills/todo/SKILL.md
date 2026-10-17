---
name: todo
description: "Manage a lightweight todo list for a small set of immediate, mostly linear steps in the current session. Use to create a checklist, show remaining work, add or complete items, reorder, or clear the list. Keep at most one item in progress; use tasks for independent execution and plan-weave for dependencies or review gates."
allowed-tools:
  - Bash
  - Bash
---

# Session Checklists

Manage the structured todo list for the current session. Biny stores the list in its session-scoped TodoStore and injects it back into the model on later turns, so it survives context compaction without becoming an executor or a second source of task truth.

## When to use

- The user provides several related steps and wants a visible checklist.
- Work is small and mostly linear, but the next action or unfinished items could be forgotten between turns.
- The user explicitly asks to add, show, reorder, complete, or clear current-session todos.

**Do NOT use for**:

- A single simple action that can be completed immediately.
- Work that must run independently in the background or survive as an execution process → use `tasks`.
- Work with prerequisites, branches, review gates, or recoverable graph state → use `plan-weave`.
- A scheduled action → use `scheduler`.

## Update the list

Use the `biny todo` CLI. Foreground commands default to the current agent session; manual commands default to the latest session unless `--session` is supplied. Updates go through the owning Host and replace its live list. A subagent must not silently change the parent session's list.


```bash
# Show the current session's list
biny todo show --json

# Show another known session's list
biny todo show --session <sessionId> --json

# Replace the complete list
biny todo replace \
  --todos '[{"content":"Inspect the current implementation","status":"in_progress"},{"content":"Run focused tests","status":"pending"}]' \
  --json

# Clear the list when the user requests it
biny todo clear --yes --json
```

## Status and update rules

- `pending` means not started.
- `in_progress` means the model is actively working on it.
- `completed` means the actual work and its relevant verification are complete.
- Keep at most **one** item `in_progress` at a time.
- Submit the full list on every update; this is a replace operation, not an append or index-based edit.
- Mark an item `in_progress` when starting it and `completed` immediately after the evidence supports completion. Add newly discovered work to the complete list rather than losing existing items.
- Keep item content concise and actionable. Do not use todo text to store secrets, long logs, or a second project plan.

## Rules

- Todo state is a coordination reminder, not proof that a command ran or a task finished. Use tool results, session events, and TaskRun state for execution evidence.
- Do not silently replace unrelated items or drop pending work while editing one item.
- Do not create a todo list for formality when the request is one step.
- If a write fails, preserve the last known persisted list and report the error; do not claim the replacement succeeded.
- Keep the user's language in item text when that is clearer; the skill instructions being in English do not require an English response.
