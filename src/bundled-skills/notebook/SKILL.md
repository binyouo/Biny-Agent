---
name: notebook
description: "Inspect and edit Jupyter .ipynb notebooks by inserting, replacing, moving, or deleting cells while preserving notebook metadata and valid JSON. Use for notebook structure or cell changes; run notebook code only when execution is requested."
allowed-tools:
  - Read
  - Write
  - Bash
---

# Notebook Editing

Treat an `.ipynb` file as a structured document. Use `Read` to inspect it and `Write` or an authorized `Bash` JSON operation to make the requested change. Do not assume a notebook-specific editing tool or Jupyter installation exists.

## Identify the target

- Read `nbformat`, `nbformat_minor`, notebook metadata, and the relevant cells before editing. Cell positions are zero-based and shift after insertion or deletion; use existing cell IDs and surrounding source to confirm the target.
- A cell's `source` may be a string or an array of strings. Join arrays without adding or removing characters; preserve a missing final newline.
- Inspect source and metadata without flooding the context with large outputs or embedded image data.

## Make the change

- Preserve notebook-level metadata, unrelated cells, cell metadata, attachments, and existing IDs.
- When code source changes, clear that cell's `outputs` and set `execution_count` to `null` so old results do not appear to prove the new code ran. Leave outputs of untouched cells intact.
- A new code cell needs `cell_type`, `metadata`, `source`, `outputs: []`, and `execution_count: null`. A markdown cell does not need code execution fields. Add a unique valid cell ID when the notebook format requires IDs.
- Serialize the complete JSON document. For shell-based edits, write to a unique temporary file in the same directory, validate it, and replace the original only if it has not changed since the read. Do not use a shared temporary filename.

## Verify

Parse the saved JSON again and check the intended cell order, source, IDs, and preserved metadata. If `nbformat` is installed, use its validator; otherwise report that JSON and cell structure were checked without full format validation. Do not install dependencies or upgrade the notebook format as part of a small edit.

Executing cells is a separate operation that can access files, networks, and credentials. Run code only within the user's request and runtime permissions, with an available kernel and a bounded execution time. A saved notebook is not an executed notebook.
