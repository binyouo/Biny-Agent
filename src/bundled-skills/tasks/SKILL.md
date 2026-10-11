---
name: tasks
description: "Create, dispatch, and monitor durable TaskRuns for background or long-running work across turns and restarts. Use for independently tracked execution, progress, cancellation, approval, or recovery; use todo for a session checklist and plan-weave for dependencies."
allowed-tools:
  - Bash
---

# Durable Tasks

A TaskRun records execution identity, lifecycle, attempts, and events. Creating a record does not start a worker. Run commands from the intended workspace and retain the IDs returned by the runtime.

## Create and dispatch

```bash
biny task create "Investigate the reported failure, apply a scoped fix, and run focused checks" --session <sessionId> --json
biny task start <taskRunId> --json
biny task get <taskRunId> --json
biny task events <taskRunId> --limit 100 --json
```

Use a known session ID. Omit `--session` when there is no intended relationship; never guess it. `--parent-run` identifies a known parent AgentRun. Optional `--verification` accepts a supported deterministic verification contract as JSON.

`start` requests asynchronous dispatch. `biny task run <taskRunId> --json` is an alternative that waits for the runtime result; do not issue both to start the same work. Inspect results before reporting that a worker started or finished.

## Monitor and steer

```bash
biny task list --newest-first --limit 20 --json
biny task inspect <taskRunId> --session <owningSessionId> --json
biny task wait <taskRunId> --session <owningSessionId> --wait-ms 30000 --after-revision <revision> --json
biny task message <taskRunId> "<scoped correction>" --session <owningSessionId> --message-id <stableMessageId> --json
biny task continue <completedTaskRunId> "<additional bounded work>" --session <owningSessionId> --message-id <stableMessageId> --json
```

Use the recorded owning session for worker operations. `wait` accepts up to 60000 ms; a timeout means no observed update, not completion. Preserve message IDs when retrying the same delivery. `continue` adds work to a completed task; do not substitute it for retrying a failed effect.

| Observed state | Meaning |
| --- | --- |
| `created` or `queued` | Recorded or waiting; execution is not yet proven. |
| `running` | An execution attempt is active. |
| `verifying` | A candidate result is being checked; completion is not final. |
| `needs_approval` or `blocked` | Inspect the exact prerequisite before proceeding. |
| `completed` | Report the recorded result and its verification evidence. |
| Failure, exhaustion, abort, or cancellation | Preserve the reason and any partial effects. |

## Approval, cancellation, and recovery

```bash
biny task approve <taskRunId> --approval-id <currentApprovalId> --json
biny task resume <taskRunId> --json
biny task cancel <taskRunId> --reason "<reason>" --json
biny task retry <taskRunId> --json
```

Approval requires the exact ID from the current `needs_approval` result and actual authorization for that action. Never reuse an old ID or approve merely to clear a blocked state. Transitions can be rejected; report the returned reason.

After a restart, inspect state and events before dispatching again. `retry` checks the recorded failure and retry safety, then requests a new execution attempt. Do not issue another start after an accepted retry. Where `start` or `run` requires `--retry-safety`, choose `safe` or `idempotent` only with evidence that replay cannot duplicate an unsafe effect. Unknown execution needs inspection and resolution before replay.

Cancellation does not undo effects already performed. Never fabricate background progress or completion from an accepted command, remembered plan, or elapsed time. Task instructions do not grant permission to delegate or bypass runtime limits.
