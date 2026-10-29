---
name: notebook
description: "Edit Jupyter notebook (.ipynb) cells: inspect, insert, replace, or delete cells while preserving metadata and valid JSON. Execute notebook code only when the task calls for execution."
allowed-tools:
  - Bash
  - Read
  - Write
---

# Notebook Edit Skill

Modify notebook cells using `jq` and Bash. Read the notebook first and identify the intended cells by ID and surrounding source; indices are zero-based and change after insertion or deletion.

The examples below use notebook format 4. Set `NOTEBOOK` to the actual path in each Bash invocation, and substitute the requested index and source. Use real newlines with Bash's `$'...'` strings, or read the source from a file with `--rawfile src`. Do not pass literal backslash-n text as cell source.

## List Cells

```bash
jq -r '.cells | to_entries[] | "\(.key): [\(.value.cell_type)] id=\(.value.id // "none") | \(.value.source | if type == "array" then join("") else . end | split("\n")[0] | .[0:80])"' "$NOTEBOOK"
```

A cell's source can be a string or an array. Join arrays without adding characters. Preserve notebook metadata, unrelated cells, existing IDs, and attachments.

## Replace a Cell's Source

This replaces cell 0 and clears stale execution results when it is a code cell. The line conversion preserves blank lines and a final line without a newline.

```bash
NOTEBOOK_TMP=$(mktemp "${NOTEBOOK}.XXXXXX") || exit 1
if jq -e --arg src $'print("hello world")\n' '
  if .nbformat != 4 or (.cells | type) != "array" or (.cells | length) < 1
  then error("Expected format 4 with cell 0") else . end
  | .cells[0].source = ($src | [scan("[^\n]*\n|[^\n]+$")])
  | if .cells[0].cell_type == "code"
    then .cells[0].outputs = [] | .cells[0].execution_count = null
    else . end
' "$NOTEBOOK" > "$NOTEBOOK_TMP"; then
  mv "$NOTEBOOK_TMP" "$NOTEBOOK"
else
  rm -f "$NOTEBOOK_TMP"
  exit 1
fi
```

## Insert a New Cell

This inserts a code cell after index 2. Retain the notebook's format version; add a unique cell ID when that format requires one.

```bash
CELL_ID=$(uuidgen) || exit 1
NOTEBOOK_TMP=$(mktemp "${NOTEBOOK}.XXXXXX") || exit 1
if jq -e --arg src $'print(42)\n' --arg id "$CELL_ID" '
  if .nbformat != 4 or (.cells | type) != "array" or (.cells | length) < 3
  then error("Expected format 4 with cell 2") else . end
  | .nbformat_minor as $minor
  | .cells |= (.[0:3] + [({
      "cell_type": "code",
      "source": ($src | [scan("[^\n]*\n|[^\n]+$")]),
      "metadata": {},
      "outputs": [],
      "execution_count": null
    } + if $minor >= 5 then {"id": $id} else {} end)] + .[3:])
' "$NOTEBOOK" > "$NOTEBOOK_TMP"; then
  mv "$NOTEBOOK_TMP" "$NOTEBOOK"
else
  rm -f "$NOTEBOOK_TMP"
  exit 1
fi
```

For a markdown cell, use `cell_type: "markdown"` and omit `outputs` and `execution_count`.

## Delete a Cell

Delete only the identified cell. This example deletes index 1:

```bash
NOTEBOOK_TMP=$(mktemp "${NOTEBOOK}.XXXXXX") || exit 1
if jq -e '
  if .nbformat != 4 or (.cells | type) != "array" or (.cells | length) < 2
  then error("Expected format 4 with cell 1") else del(.cells[1]) end
' "$NOTEBOOK" > "$NOTEBOOK_TMP"; then
  mv "$NOTEBOOK_TMP" "$NOTEBOOK"
else
  rm -f "$NOTEBOOK_TMP"
  exit 1
fi
```

## Verify and Tips

- Use unique temporary files beside the notebook so a parse failure cannot truncate the original. Read the current notebook again if another editor has changed it.
- Parse the saved JSON and check the intended source, cell order, IDs, and preserved metadata. If `nbformat` is installed, validate the result; otherwise state that only JSON and cell structure were checked.
- Back up the notebook before complex edits. Small changes can also use Read/Write directly on the JSON while preserving the same rules.
- Editing source does not execute it. Run cells only when requested, using an available kernel and a bounded timeout; do not install a kernel or upgrade the notebook format for a small edit.
