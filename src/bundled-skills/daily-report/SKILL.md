---
name: daily-report
description: "Build an evidence-based work journal for a day or date range, grouped by project, theme, and outcome. Use for questions about today, yesterday, last week, completed work, or daily reports. Prefer biny activity report for day-level coverage; use digest for a recent overview and disclose missing records."
allowed-tools:
  - Bash
---

# Daily Work Reports

Generate a thematic work journal from Biny's local activity records. The report is grouped by project, theme, and outcome; it is not intended to be a minute-by-minute timeline.

Use `report` for outcomes across a day; use `digest` for a recent timeline.

## When to use

Use this skill for a **day-level or multi-day** question about the user's own activity:

- what did I do today / yesterday / last Friday
- summarize my week / give me a recap / work journal / daily report
- any request where the answer should be organized by outcomes or themes rather than timestamps

**Do NOT use for**:

- "What was I just doing?" → use `biny activity digest` with an appropriate lookback window.
- "Find the activity about this code/project" → use `biny activity search <query>`.
- "Show recent or specific sessions" → use `biny activity sessions [limit]`, optionally with `--since`.
- A request about the daily note itself → use `biny diary show [date]`.

## How to use

Run the CLI from the current workspace. Its plain output is the finished Markdown journal; relay it verbatim.

```bash
# Today's report
biny activity report today

# Yesterday
biny activity report yesterday

# A specific date
biny activity report <YYYY-MM-DD>

# Recent timeline instead of a day-level journal
biny activity digest --lookback 120
```

`report` reuses a cached journal when available. Use `--force` only when the requested report needs regeneration. `--skeleton` produces a deterministic report from stored analyses without a new model-generated narrative; identify that mode when returning it. Resolve the date range in the user's local time before requesting individual days.

When the user asks a follow-up about one project or event, drill down with `biny activity search` (use `biny activity search semantic <query>` when keyword search misses meaning-based recalls), `biny activity sessions`, or `biny activity show <session-id>` for one session's events, snapshots and analysis, instead of regenerating the whole report.

## Output rules

- Paste successful report output directly. Do not rewrite, translate, shorten, add a preface, or append another summary. Preserve partial-analysis notices and missing-data messages.
- For multiple days, run the report once for each requested date and relay the outputs in date order, without synthesizing an additional combined report.
- Use `--json` only if the user explicitly requests machine-readable output; do not use it as a way to rewrite the journal.
- For a follow-up interpretation rather than a report, keep any inference separate from the recorded facts. A session or screenshot is not proof that an action completed.

## Failure modes

- If `biny activity report` fails, report the failure and fall back to `biny activity digest` only when a recent overview is still useful. Say explicitly that the day-level journal could not be built.
- If the report has no analyzed sessions, relay that there is no verifiable activity for the requested date and suggest checking `biny activity status`.
- If only part of the activity has been analyzed, state that the report is partial; do not fill the gap from conversation context.
- The Activity pipeline may send redacted text to the configured model. Do not separately upload screenshots, databases, or raw files to another service.
