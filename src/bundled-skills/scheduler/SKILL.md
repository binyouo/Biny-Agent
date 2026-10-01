---
name: scheduler
description: "Create, inspect, pause, resume, run, or delete durable local automations and heartbeat patrols. Use whenever the user asks for a reminder, a one-time delayed action, a recurring job, a daily or periodic check, a cron-like schedule, or heartbeat configuration; triggers include: remind me later, every morning, run this every hour, schedule this, cron, heartbeat, 定时执行, 每天执行, and 到点提醒. Resolve the exact time, timezone, target session, prompt, and execution mode before changing durable state; use `biny automation` or `biny heartbeat`, and do not treat a scheduled trigger as proof that execution or notification succeeded."
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
  --at "2026-09-10T20:00:00+08:00" \
  --prompt "Remind me about the meeting" \
  --json

# Add a recurring cron job
biny automation create "Morning review" \
  --trigger cron \
  --cron "0 9 * * *" \
  --prompt "Review today's local activity and report anything requiring attention" \
  --json

# Add an interval job
biny automation create "Periodic check" \
  --trigger interval \
  --interval-ms 3600000 \
  --prompt "Check the configured local sources" \
  --json
```

Supported creation options include `--cron`, `--interval-ms`, `--at`, `--jitter-ms`, `--session`, `--max-fires`, and `--expires-at`. Use only options that are supported by the requested trigger. After creating a job, run `biny automation list --json` again and verify the stored trigger, prompt, target session, and expiry. Use `biny automation pending [automationId] --json` to inspect pending, running, deferred, completed, failed, or approval-gated fires.

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

`biny heartbeat show` reads the local heartbeat checklist. Editing that checklist or changing persistent heartbeat behavior is a separate state-changing action and must remain within the user's request and runtime permissions.

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

- Resolve time, timezone, prompt, target session, mode, expiry, and failure expectations before creating durable state. Never guess an ambiguous time.
- A trigger is not proof of execution. A run is not proof of completion. Use runtime records, TaskRun state, tool results, and delivery evidence.
- `--expires-at` stops new fires at the deadline. Fires durably created before it may still start or finish afterward, subject to pause, deletion, and fire-count limits; it is not an Agent run timeout.
- Biny's current automation interface targets a local session; do not add unsupported external delivery targets or claim a message was sent.
- Deletion and material changes to a long-lived job need explicit user intent. Preserve the exact rejection or unavailable-runtime error.
- If the scheduler is busy or the target session is unavailable, report the deferred, failed, or pending state instead of saying the action happened.
