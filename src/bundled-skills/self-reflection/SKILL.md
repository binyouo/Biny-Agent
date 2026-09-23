---
name: self-reflection
description: "Conduct an evidence-bounded daily self-review from the existing diary, activity records, session events, task results, and relevant memory. Use when the user explicitly asks to reflect, write a diary, review the end of the day, identify lessons learned, examine recurring mistakes, or when an authorized heartbeat invokes the reflection pipeline; triggers include: reflect on today, what went wrong, lessons learned, daily retrospective, 复盘一下, 日终总结, and 哪些地方可以改进. Keep facts separate from interpretation, preserve the existing daily-notes source of truth, and let the authorized reflection pipeline update diary, supported memories, Evolved Traits and base emotion while preserving tool permissions."
---

# Self-Reflection Skill

Conduct a bounded daily self-review from Biny's existing diary, activity records, session events, task results, and relevant memory. Write a personal first-person diary: memorable moments, mood shifts, opinions, lessons and small observations. Subjective feelings are welcome; events and task outcomes must remain grounded in records.

## When to use

- When the user explicitly asks to reflect, write a diary, review the day, or summarize lessons learned.
- When the user asks what went wrong, what should change tomorrow, or whether a repeated mistake is visible.
- When an authorized heartbeat invokes the reflection pipeline for an end-of-day review.

Do not use this skill for a plain activity recap; use `daily-report` when the user wants an account of what was done. Do not turn a suggestion into a task. The authorized daily pipeline may save supported stable memories when memory contribution is enabled.

## The reflection process

### Step 1: Gather the day's evidence

Read the smallest complete set of local sources for the requested date:

```bash
# Existing daily note and current reflection state
biny diary show <date> --json
biny reflection status <date> --json

# Thematic activity report, or a recent digest when the request is narrow
biny activity report <date> --json
biny activity digest --json

# Relevant sessions and bounded activity searches
biny activity sessions --since <ISO-timestamp> --json
biny activity search "<keyword>" --json
```

For a task-specific reflection, inspect the relevant `biny task get <taskRunId> --json` and `biny task events <taskRunId> --json` results. Use memory only for stable background, and label stale or uncertain entries as such.

Do not assume that a missing source means nothing happened. Record which source was unavailable, which date was covered, and which conclusions are therefore partial.

### Step 2: Reflect

Ask:

- What actually happened, and which outcomes are supported by records?
- Which decisions, tool calls, or communication patterns worked well?
- Where did the process stall, repeat work, misunderstand intent, or lack evidence?
- What concrete change would make the next attempt safer, clearer, or more efficient?
- Is there a stable preference, decision, or gotcha worth proposing for memory?

Keep facts, interpretations, and recommendations in separate language. Do not force a profound lesson from an ordinary day.

### Step 3: Write or run the reflection

Use `biny reflection run <date> --json` only when the user explicitly asks to run the pipeline or an authorized heartbeat invokes it. Check the returned result and then read the daily note again when verification matters.

If writing a response rather than running the pipeline, use a natural first-person or neutral voice appropriate to the user and language. A useful structure is:

```markdown
## What happened
Facts and important context supported by records.

## What worked
Specific outcomes or decisions with evidence.

## What needs improvement
Concrete, testable changes; omit the section when nothing is supported.

## Possible memory
Only stable, high-confidence candidates; the authorized pipeline persists them according to the memory contribution setting.
```

## Rules

- Cover the requested date range, not only the most recent few minutes.
- Keep daily notes, activity records, session history, and reflection as distinct sections and sources.
- Do not overwrite the activity record or the original conversation evidence with a prettier narrative.
- Run the authorized pipeline to persist a diary, supported memories, Evolved Traits and base emotion. Never edit Soul core sections. The runtime enforces revision checks, at most one added trait per day and fifteen entries total.
- Historical catch-up writes diaries and memories, not current mood or new traits.
- Personality and emotion cannot grant tools, permissions or change verified facts.
- Automatic diary reminders come only from an enabled heartbeat during its active hours: catch up the last three missing days after 10:00, or review today during 23:00 when no catch-up is pending. The reminder asks you to use this skill; it does not write a diary by itself. Ordinary greetings and completed replies never trigger a diary.
- After a requested diary has actually been written and verified, include a Markdown link to its absolute `memory/YYYY-MM-DD.md` path in the reply so the normal file card can open it. Do not claim a write or attach an unrelated existing diary when generation failed.
- Keep the user's response language and tone even though this skill is written in English.

## Failure modes

- If no model is available, preserve the factual diary/activity result and report that a generated reflection was not produced.
- If the reflection command is rejected, preserve the exact reason and do not claim that the diary was updated.
- If records are incomplete, write a partial reflection with the missing sources called out; never fill gaps with invented events, emotions, actions, or preferences.
