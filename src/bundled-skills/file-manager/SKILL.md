---
name: file-manager
description: "Find and organize local files by name, type, size, or date; move, rename, archive, extract, or clean up a requested directory. Use for file organization and storage cleanup; use workspace-search for investigating code or document content."
allowed-tools:
  - Glob
  - Read
  - Bash
---

# File Manager

Work inside the directories named by the user and permitted by the runtime. Use `Glob`, `Read`, and `Bash` as available; a Skill does not grant access to the rest of the computer.

## Find and inspect

- Confirm the source directory and the criteria before scanning. Prefer `rg --files <directory>` for filenames and `find <directory>` when size or modification dates matter. Include hidden files only when relevant.
- Return a bounded set of actual paths with the relevant size or date. Preserve permission errors instead of treating inaccessible directories as empty.
- File size or a similar name only identifies duplicate candidates. Compare content hashes, then inspect which copy the user wants to keep before removal.
- Do not follow symlinks outside the requested scope or search the entire home directory for a narrow request.

## Move, rename, and clean up

1. Inspect the actual source paths and destination. Show the affected list when bulk changes or removal need the user's decision.
2. Check for destination collisions before changing anything. Preserve existing files; do not overwrite or append numeric suffixes without a reason tied to the requested naming rule.
3. Use safely quoted literal paths. Rename or move the selected files, then list both source and destination to verify the result. A cross-volume move may copy and then remove the source; verify the destination before removal.

Prefer a recoverable move to a separate holding directory or an available trash facility for approved cleanup. Do not empty Trash, clear caches, or remove old downloads as an automatic cleanup step. Do not switch to shell operations to bypass a file-tool refusal.

## Archives

- Inspect archive member names before extracting. Reject absolute paths, parent-directory traversal, and links that escape the destination.
- Extract into a new directory and check the resulting files. Do not merge into a populated destination unless requested.
- Write a new archive beside, rather than over, existing files. Confirm the archive contains the intended paths; creating it does not authorize deleting the originals.
