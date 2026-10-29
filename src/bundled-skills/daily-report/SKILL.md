---
name: daily-report
description: "Generate a rich work journal for a specific day, grouped by project/theme with PR links, @mentions, versions, and decisions — NOT a minute-by-minute timeline. Use this whenever the user asks about their day, yesterday, last Friday, this week, or similar. Triggers: 'what did I do today', 'recap my day', 'summarize yesterday', 'work journal', 'daily recap'."
allowed-tools:
  - Bash
---

# Daily Report Skill

Generate a thematic work journal from the user's on-screen activity records.

This skill is how Biny answers day-scope activity questions. It exists because the generic `biny activity digest` returns a time-ordered list of session titles (good for "what was I just doing 10 min ago") but is too shallow for "what did I get done today".

## When to use

Use this skill when the user asks a **day-level or multi-day** question about their own activity:

- 我今天都干啥了 / 今天做了什么 / 今天的工作总结
- 昨天呢？/ 我昨天干啥了
- what did I do today / yesterday / last Friday
- summarize my week / give me a recap / 打工日记
- Any question where the answer should be organized by what got done, not by timestamps

**Do NOT use for**:
- "What was I just doing?" → use `biny activity digest` (last ~2h)
- "Find that code I was looking at" → use `biny activity search <query>` / `search semantic`
- "Show me session X" → use `biny activity show <id>`

## How to use

Run the CLI, pipe its markdown straight into your reply. It already produces a polished report — do not rewrite, condense, or reformat it.

```bash
# Today's report
biny activity report today

# Yesterday
biny activity report yesterday

# A specific date
biny activity report 2026-04-17

# Force regeneration (bypass 10min cache)
biny activity report today --force
```

The command is safe to run unconditionally: it will return `# <date> 打工日记 … 今天没有可分析的活动记录。` if nothing has been recorded yet, and you should relay that as-is.

## Output rules

1. **Paste the markdown verbatim** as your reply. The report already has a title, section headings, PR links, @mentions, versions, and decisions — don't strip or reflow them.
2. **Do not add a summary at the top.** The report's opening paragraph is the summary.
3. **Do not narrate time.** The report intentionally de-emphasizes "at 10:03 you did X" — that's the pattern the user called out as useless. If they want a minute-by-minute view, they'll ask and you run `biny activity digest` instead.
4. **Match the user's language.** The report detects Chinese/Japanese/English from the underlying OCR. Don't translate it.
5. If the user asks a follow-up like "tell me more about the tokenspeed part", drill down with `biny activity sessions` + `biny activity show <id>` — not by re-running the report.

## Failure modes

- If `biny activity report` returns an error, fall back to `biny activity digest` and explain briefly that the day-level journal couldn't be built.
- If the report is empty (no analyzed sessions for that date), relay it and suggest the user check `biny activity status` to confirm the recorder was running.
- Never fabricate activity details. Every PR number, person handle, version, or decision in your reply must appear in the report output.
