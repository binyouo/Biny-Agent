---
name: memory-management
description: "Search and manage Biny's local facts and conversation history. Use for earlier decisions, preferences, remembering information, correcting facts, or forgetting and cleaning up memory. Search before writing; never save secrets or guesses."
allowed-tools:
  - Bash
---

# Memory Management Skill

Memory is advisory. Current instructions, files, tool results and permissions take precedence.

## When to Use

- The user asks about a past conversation, preference, decision, or plan: search memories and conversation history.
- The user says "remember this": search for an equivalent fact before adding it.
- The user corrects a fact or asks to forget something: identify the matching entry, then update or remove that entry.
- A question depends on who said something or the original wording: find the source conversation, not only a derived memory.

## Recall earlier context

Search facts for stable preferences and decisions. Search conversation history when the question concerns who said something, the original wording, a date, or how a decision evolved. For questions about past conversations, try both `biny memory search` for related concepts and `biny memory grep` for literal terms. If one returns no matches, the other can still help. Use `biny history search` for full-text queries and reconcile results against current evidence.


```bash
biny memory search "<query>" --json
biny memory search "<query>" --tag preference workflow --json
biny memory search "<query>" --thread-id <threadId> --json
biny history day <YYYY-MM-DD> --json
biny memory list --json
biny memory get <id> --json
biny memory stats --json
biny history search "<keywords>" --json
biny memory grep "<literal text>" --json
biny memory archive
```

- Facts share one library across workspaces. Tags match any given tag. Use `--thread-id`, `--user-id`, or `--user-ids` only with known identities when a filtered search is needed; these filters are not filesystem or project isolation boundaries.
- Automatic recall requires working embeddings; when unavailable it injects no facts. Explicit memory search can fall back to lexical matching and reports degradation.
- History search refreshes old local sessions before querying. `grep` matches literal substrings, including punctuation. `archive` exports conversation Markdown to the agent's `threads/` directory; it does not remove facts or conversations.
- Search hits are previews. Read the returned source or the relevant day's history before claiming full coverage; follow archived tool-output references when output is too large.
- Interpret relative dates using the source conversation's timestamp and timezone. A remembered intention, scheduled reminder, or suggested action is not proof of completion. Preserve original quotes, known source IDs, and separate event, deadline, and completion dates. If the original timestamp or zone is unknown, leave it unknown rather than resolving "tomorrow" against today. Cite the source session or entry when it matters, and label historical facts that conflict with current state.
- If there are no matches, say so. Never invent a remembered fact or claim a transcript was searched without actual results.

## Person-Specific Recall

Use known `--user-id` or `--user-ids` filters for person-specific memory and `--thread-id` for a known source conversation. Do not invent identities or create a parallel people-profile directory. Conversation history is read through Biny's history commands; do not assume group or private chats are exported into separate daily log folders.

## Write and manage

```bash
biny memory add "The user prefers concise answers in Chinese" --json
biny memory add --entry '{"content":"The user prefers concise answers in Chinese","tags":["preference"],"importance":0.5}' --json
biny memory update <id> --entry '{"content":"Updated fact"}' --json
biny memory archive-entry <id> --yes --json
biny memory archived --json
biny memory restore <archive-id> --json
biny memory delete <id> --yes --json
biny memory clear --yes --json
```

- Save supported, self-contained facts. Search for equivalents first. Never save credentials, speculation, transient plans or assistant-generated claims as user facts.
- Explicit writes follow user intent. Authorized background extraction and reflection can write when enabled without asking for every fact.
- `archive-entry` removes a fact from recall but keeps it restorable. Restore uses the archive ID from `archived`.
- `delete` permanently removes the selected entry. Unfiltered `clear` removes all active and archived facts in the shared library, not just this project. `clear --thread-id <threadId>` targets that thread's active facts. Resolve the intended target and consequence before deletion; do not use global clear for a narrow correction.
- After a correction, read the updated entry and preserve provenance or scope fields from the existing record. Saving a fact does not prove semantic retrieval is ready.
- Report actual results, including duplicate skips and errors.

## Sleep consolidation

```bash
biny memory sleep --json
biny memory sleep --preview --json
biny memory sleep --runs --json
biny memory sleep --run --yes --json
biny memory sleep --cancel --json
```

Preview before requested cleanup. Sleep can archive duplicates, expired temporary facts and similar clusters; LLM synthesis requires a usable model. Cancellation does not roll back committed work. Background scheduling requires a live Runtime Host; it does not wake a powered-off computer.
