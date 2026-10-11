---
name: workspace-search
description: "Search the current workspace when the user asks to inspect local code, documentation, configuration, data, history, or whether related material exists. Use native Grep for exact text, identifiers, filenames, paths, regular expressions, and exhaustive matches; use an available zvec_grep_search MCP tool for unknown wording, semantic discovery, relationships, or cross-file synthesis."
allowed-tools:
  - Grep
  - Read
  - Bash
---

# Workspace Search

Use the current workspace as evidence when the user asks about local files, local history, project behavior, or whether related material exists in the repository. Keep the search scope tied to the active workspace and report the paths and source locations returned by the tools.

## Retrieval routing

| Intent | Route |
| --- | --- |
| Exact word, quotation, identifier, filename, path, key, source fragment, or regular expression | `Grep` |
| Exhaustive occurrence search | `Grep` or native `rg` through `Bash` |
| Wording or location is unknown | `zvec_grep_search` when it is available |
| Semantic, fuzzy, relationship, chronology, causality, comparison, or cross-file discovery | `zvec_grep_search` when it is available |
| Known exact anchor but broader context is needed | `zvec_grep_search`, then focused `Grep` |

## Exact searches

Use `rg` through `Bash` when a shell search is appropriate. Scope the directory and choose literal or regular-expression matching deliberately:

```bash
rg -n -F -- 'exact identifier' src tests
rg --files src | rg 'settings|skill'
rg -n --glob '*.ts' -- 'pattern' src
```

Read the relevant surrounding code and trace its callers before explaining behavior. Report file paths and line locations. A ranked excerpt does not establish every occurrence; an empty search of one directory does not establish repository-wide absence.

## zvec_grep_search

The indexed search tool is optional. It is available when the current runtime exposes an MCP tool whose name ends with `zvec_grep_search`.

- Pass the absolute current workspace root as `root`.
- Keep `limit` bounded; start with one focused probe for a vague conceptual question.
- Use `query` for a natural-language or hybrid search. Add `fts`, `vector`, `globs`, or `fileTypes` only when the task benefits from those constraints.
- Treat returned paths, line ranges, freshness, and source excerpts as evidence. Read the relevant file or run focused `Grep` before making an exact claim when the result needs verification.
- Do not create, rebuild, drop, or silently broaden an index as part of an ordinary search request. Index lifecycle is an explicit setup or maintenance operation.

## Boundaries

- Do not use semantic search for current external facts or unrelated open-world knowledge; use the appropriate external source.
- Do not replace exact search with a ranked semantic result when the user asks for every occurrence, a literal match, a path, a filename, a key, or a regular expression.
- Stop when a focused semantic probe is not relevant instead of repeatedly searching with paraphrases.
