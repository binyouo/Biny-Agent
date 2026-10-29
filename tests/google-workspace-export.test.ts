import assert from "node:assert/strict";
import test from "node:test";
import { googleWorkspaceExportUrl } from "../src/browser/googleWorkspaceExport.js";

test("Google Workspace export URLs match the current document type and sheet", () => {
  assert.deepEqual(googleWorkspaceExportUrl("https://docs.google.com/document/u/0/d/doc-1/edit", "docx"), {
    url: "https://docs.google.com/document/d/doc-1/export?format=docx", kind: "document"
  });
  assert.deepEqual(googleWorkspaceExportUrl("https://docs.google.com/spreadsheets/d/sheet_1/edit#gid=42", "csv"), {
    url: "https://docs.google.com/spreadsheets/d/sheet_1/export?format=csv&gid=42", kind: "spreadsheets"
  });
  assert.deepEqual(googleWorkspaceExportUrl("https://docs.google.com/presentation/d/slides-1/edit", "pptx"), {
    url: "https://docs.google.com/presentation/d/slides-1/export?format=pptx", kind: "presentation"
  });
  assert.deepEqual(googleWorkspaceExportUrl("https://docs.google.com/document/d/doc-1/edit", "md"), {
    url: "https://docs.google.com/document/d/doc-1/export?format=md", kind: "document"
  });
  assert.deepEqual(googleWorkspaceExportUrl("https://docs.google.com/drawings/d/drawing-1/edit", "svg"), {
    url: "https://docs.google.com/drawings/d/drawing-1/export?format=svg", kind: "drawings"
  });
});

test("Google Workspace export rejects other pages and unsupported file types", () => {
  assert.throws(() => googleWorkspaceExportUrl("https://example.com/document/d/doc-1/edit", "docx"), /docs.google.com/u);
  assert.throws(() => googleWorkspaceExportUrl("https://docs.google.com:8443/document/d/doc-1/edit", "docx"), /docs.google.com/u);
  assert.throws(() => googleWorkspaceExportUrl("https://docs.google.com/document/d/doc-1/edit", "xlsx"), /不支持/u);
  assert.throws(() => googleWorkspaceExportUrl("https://docs.google.com/document/d/", "docx"), /不是可导出/u);
});
