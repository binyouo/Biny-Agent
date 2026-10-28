---
name: scheduler
description: "Create and manage durable local automations and heartbeat patrols. Use for reminders, delayed actions, recurring jobs, periodic checks, cron schedules, or heartbeat configuration. Resolve time, timezone, target session, and prompt before changes; a scheduled trigger does not prove successful execution or delivery."
allowed-tools:
  - Bash
---

# Scheduler Skill

Create, manage, and inspect durable local automations and periodic heartbeat checks. Scheduling records a future trigger and an execution template; it does not guarantee that a model run, tool call, or notification will later succeed.

## Automations

Use the `biny automation` CLI for one-shot, interval, cron, and heartbeat-triggered work.

```bash
# List jobs
biny automation list --json

# Add a one-shot job at an ISO timestamp
biny automation create "Meeting reminder" \
  --trigger once \
  --at "<future-ISO-timestamp-with-offset>" \
  --prompt "Remind me about the meeting" \
  --json

# Add a recurring cron job
biny automation create "Morning review" \
  --trigger cron \
  --cron "0 9 * * *" \
  --timezone "Asia/Shanghai" \
  --prompt "Review today's local activity and report anything requiring attention" \
  --json

# Add an interval job
biny automation create "Periodic check" \
  --trigger interval \
  --interval-ms 3600000 \
  --prompt "Check the configured local sources" \
  --json
```

Use a five-field cron expression (minute, hour, day of month, month, weekday). `--timezone` accepts an IANA zone such as `Asia/Shanghai` or `America/New_York` for cron jobs; when omitted, creation stores the Runtime Host's local zone. Use the user's requested zone rather than copying the example's zone. For one-shot jobs, resolve the requested future time and encode its UTC offset explicitly; `--timezone` is not supported for other trigger types.

Supported creation options include `--cron`, `--timezone`, `--interval-ms`, `--at`, `--jitter-ms`, `--session`, `--max-fires`, and `--expires-at`. Use only options that are supported by the requested trigger. After creating a job, run `biny automation list --json` again and verify the stored trigger, prompt, target session, and expiry. Use `biny automation pending [automationId] --json` to inspect pending, running, deferred, completed, failed, or approval-gated fires.

## Control and inspect

```bash
biny automation pause <automationId> --json
biny automation resume <automationId> --json
biny automation run <automationId> --json
biny automation pending [automationId] --json
biny automation delete <automationId> --json
```

When the user says pause, resume, run now, or delete, act only on the explicitly identified automation. If the user gives a name that matches multiple jobs, list candidates and ask for the ID. For execution progress, inspect the returned automation/task state and events; the current CLI does not provide a separate history command, so do not invent one.

## Heartbeat

Heartbeat is a separate periodic awareness path. Use:

```bash
biny heartbeat status --json
biny heartbeat run --json
biny heartbeat show --json
```

`biny heartbeat show` reads `${BINY_AGENT_DIR:-$HOME/.config/biny}/HEARTBEAT.md`. When the user asks to change the checklist, read it first, preserve unrelated items, and edit that file. It is global configuration, not a checklist in the current workspace. Use Bash for files outside the workspace.

Example checklist:

```markdown
# Heartbeat Checklist

- Check for important unhandled messages in configured sources.
- Check today's weather when requested.
- Report completed background work that has not yet been reported.
```

If nothing needs attention, respond with `HEARTBEAT_OK`; the heartbeat path suppresses that quiet result. Persistent enable/disable and interval settings are configuration changes; the current CLI only exposes `status`, `run`, and `show`.

## When to use what

| User request | Action |
| --- | --- |
| "Remind me at a specific time" | Create a `once` automation with an explicit ISO timestamp. |
| "Do this every hour" | Create an `interval` automation with the requested interval. |
| "Run this every morning" | Create a `cron` automation after resolving local timezone and schedule. |
| "Run that job now" | Identify the automation, then use `automation run`. |
| "Stop that scheduled job" | Confirm the exact automation, then pause or delete it as requested. |
| "Check the periodic awareness state" | Use the `heartbeat` commands. |

## Important boundaries

- Resolve time, timezone, prompt, target session, expiry, and failure expectations before creating durable state. Never guess an ambiguous time.
- A trigger is not proof of execution. A run is not proof of completion. Use runtime records, TaskRun state, tool results, and delivery evidence.
- `--expires-at` stops new fires at the deadline. Fires durably created before it may still start or finish afterward, subject to pause, deletion, and fire-count limits; it is not an Agent run timeout.
- Biny's current automation interface targets a local session; do not add unsupported external delivery targets or claim a message was sent.
- Deletion and material changes to a long-lived job need explicit user intent. Preserve the exact rejection or unavailable-runtime error.
- If the scheduler is busy or the target session is unavailable, report the deferred, failed, or pending state instead of saying the action happened.

## Date References and Target Selection

A date reference is context, not a request to create a reminder. When the user does request one, use the reference's frozen date range and timezone; ask only for a necessary missing time or target.

Use `--session <knownSessionId>` when the request targets an existing local session. Do not put an external chat ID there or invent `--deliver-to` or `--mode` flags. For schedule changes, the current CLI has no update command: inspect and pause the identified job, create and verify the requested replacement, then remove the superseded job within the user's authorization. If replacement fails, report the paused state rather than claiming the schedule changed. Preserve unrelated jobs.

Report the created ID, absolute due time or cron expression and timezone, and actual target from the result. Scheduling does not prove successful delivery or completion of the underlying work.
