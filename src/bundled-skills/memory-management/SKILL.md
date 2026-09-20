---
name: memory-management
description: "Search and manage Biny's local facts and conversation history. Use for earlier decisions, preferences, remember this, forget that, 记住这个, 查一下记忆, 我的偏好, 删除记忆, or 清理记忆. Search before writing; never save secrets or guesses."
---

# Memory management

Memory is advisory. Current instructions, files, tool results and permissions take precedence.

## Search

```bash
biny memory search "<query>" --json
biny memory search "<query>" --tag preference workflow --json
biny memory list --json
biny memory get <id> --json
biny memory stats --json
biny history search "<keywords>" --json
biny memory grep "<literal text>" --json
biny memory archive
```

- Facts share one global library across workspaces. There is no selector, scope or project partition parameter. Tags match any given tag; they are not access boundaries.
- Automatic recall requires working embeddings; when unavailable it injects no facts. Explicit memory search can fall back to lexical matching and reports degradation.
- History search refreshes old local sessions before querying. `grep` matches literal substrings, including punctuation. `archive` exports conversation Markdown to the agent's `threads/` directory; it does not remove facts or conversations.
- A live Runtime Host mirrors transcripts at startup, every 30 minutes, and on graceful shutdown. Unchanged files are left intact; failed exports retry next time. Check `threads/.mirror-status.json` for failures. Removing a source conversation also removes its generated snapshot on the next pass, but never user-created files or unmarked legacy exports.
- If there are no matches, say so. Never invent a remembered fact or claim a transcript was searched without actual results.

## Write and manage

```bash
biny memory add "用户喜欢简洁中文回答" --json
biny memory add --entry '{"content":"用户喜欢简洁中文回答","tags":["preference"],"importance":0.5}' --json
biny memory update <id> --entry '{"content":"更新后的事实"}' --json
biny memory archive-entry <id> --yes --json
biny memory archived --json
biny memory restore <archive-id> --json
biny memory delete <id> --yes --json
biny memory clear --yes --json
```

- Save supported, self-contained facts. Search for equivalents first. Never save credentials, speculation, transient plans or assistant-generated claims as user facts.
- Explicit writes follow user intent. Authorized background extraction and reflection can write when enabled without asking for every fact.
- `archive-entry` removes a fact from recall but keeps it restorable. Restore uses the archive ID from `archived`.
- `delete` permanently removes the selected entry; `clear` removes all active and archived facts in the shared library, not just this project. Confirm exact targets and consequences first.
- Writes do not require a revision or CAS retry. SQLite transactions commit facts; embeddings are rebuildable derived data. Saving a fact does not prove semantic retrieval is ready.
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

For local integrations, `biny memory serve` exposes an authenticated loopback API and a read-only `/ws/memory` subscription on the same port. Both require a Bearer header and reject browser origins. The stream sends current state on connect and changed state afterward; progress is sampled once per second, not a replayable audit log. See the memory section in the repository's `README.md` for event names.
