---
name: memory-management
description: "Search and manage Biny's persistent local memory when the user asks about past conversations, personal facts, preferences, project decisions, or anything that requires recalling information. Use for requests such as do you remember my preference, what did we decide before, help me find what we said, remember this, forget that, search memory, list memories, archive an entry, or clear a scope; triggers include: what do you know about me, we talked about this before, 记住这个, 查一下记忆, 我的偏好, 删除记忆, and 清理记忆. Search before writing, treat memory as advisory rather than current authority, and require explicit confirmation for destructive operations; do not save secrets, guesses, or temporary context."
---

# Memory Management Skill

Search and manage Biny's persistent local memory. Memory is useful for continuity, but it is advisory context rather than authority: current user instructions, current files, current tool results, and runtime permissions always take precedence.

## Commands

```bash
# List memories. Selector: all, current, user, or other
biny memory list [selector] --json

# Show store totals, per-scope/kind distribution, and maintenance status
biny memory stats --json

# Search semantically within a selector
biny memory search "<query>" --selector current --json

# Add one structured memory entry after explicit user intent
biny memory add --entry '<json>' --json

# Archive one entry or clear a selected scope; both require confirmation
biny memory archive <id> --yes --json
biny memory clear [selector] --yes --json

# Inspect maintenance state, or run maintenance after confirmation
biny memory sleep --json
biny memory sleep --run --yes --json
```

## When to use

- **Past information** — "do you remember my preference", "what did we decide before", or "help me find what we said" → search memory before answering.
- **Explicit saving** — "remember this" or a clearly stated stable preference → search for an equivalent entry, then save only the durable fact.
- **Forgetting** — "forget that" or "remove this memory" → identify the exact entry or selector, confirm the scope, then archive or clear it.
- **Maintenance** — the user explicitly asks to consolidate or clean up memory → inspect `biny memory sleep` first and run it only with confirmation.

## Search strategy

1. Start with `biny memory search` for conceptual or vague questions.
2. Use `biny memory list` to inspect the surrounding entries, selector, revision, and archived state.
3. If the question is about exact conversation wording and memory search is insufficient, use the session/history capabilities that are actually available in the current runtime. Do not invent a `memory grep` command or claim that archived conversation text was searched when it was not.
4. If a search returns nothing, say so. Do not complete the answer from model recollection.
5. Distinguish explicit user preferences, project decisions, facts, workflow notes, inferences, and stale entries.

## Writing rules

- Explicit tool writes follow user intent or a clearly established stable preference. Authorized background extraction and daily self-reflection may save stable, supported facts when memory contribution is enabled; do not ask again for each automatic memory.
- Search before writing to avoid duplicates; preserve the correct audience, topic, source, and durability.
- Never save passwords, API keys, one-time codes, private credentials, or sensitive details merely because they appeared in context.
- Do not promote a temporary plan, speculative interpretation, or assistant-generated prose into a user fact.
- After a write, report what was stored and the actual command result.

## Archiving, clearing, and conflicts

- Archive and clear are state-changing operations. Confirm the exact ID or selector before running the command, and keep `--yes` as an explicit confirmation boundary.
- `biny memory sleep --run --yes` may reorganize or archive stale, duplicate, or low-value entries; explain this before running it.
- On a revision or compare-and-swap conflict, re-read the current list once and decide whether a narrow retry is safe. Never overwrite a newer update blindly.
- If storage, the Runtime Host, or the model is unavailable, preserve the exact error and say which part was not completed.

## Boundary

- Memory cannot replace a current tool query, a current file, or a permission decision.
- Memory retrieval must not silently widen a project or user selector.
- Always confirm what was recalled, stored, archived, or cleared from actual output; never claim success without evidence.
