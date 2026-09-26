import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/schema.js";
import { analyzePermissionRequest } from "../src/permission/policy.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { parseGoogleResults, parseXiaohongshuResults, createWebSearchTool } from "../src/tools/web/search.js";

function testGoogleParser(): void {
  const results = parseGoogleResults(`
    <a href="/url?q=https%3A%2F%2Fexample.com%2Fguide&amp;sa=U"><h3>Example &amp; guide</h3></a>
    <div>Useful <b>first</b> result.</div>
    <a href="https://example.org/reference"><h3>Reference</h3></a>
    <div>Second result.</div>
  `, 5);

  assert.deepEqual(results, [
    { title: "Example & guide", url: "https://example.com/guide", snippet: "Useful first result." },
    { title: "Reference", url: "https://example.org/reference", snippet: "Second result." }
  ]);
}

function testWebSearchPermission(): void {
  const request = analyzePermissionRequest({
    toolName: "WebSearch",
    args: { query: "Chicago weather" },
    sessionId: "test",
    projectRoot: "/tmp"
  });
  assert.equal(request.actionType, "read");
  assert.equal(request.riskLevel, "low");
}

function testWebSearchRegistration(): void {
  const registry = createToolRegistry(
    { workspaceRoot: "/tmp", ignore: [] },
    defaultConfig.web.search,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { endpoint: "/tmp/browser.sock", token: "test-token" }
  );
  assert.equal(registry.get("WebSearch").name, "WebSearch");

  const withoutBrowser = createToolRegistry({ workspaceRoot: "/tmp", ignore: [] }, defaultConfig.web.search);
  assert.throws(() => withoutBrowser.get("WebSearch"), /Unknown tool: WebSearch/);
}

testGoogleParser();
testWebSearchPermission();
testWebSearchRegistration();
const notes = parseXiaohongshuResults('<section class="note-item"><a href="/search_result/abc123?xsec_token=test&amp;xsec_source=pc_search"></a><a class="title"><span>旅行笔记</span></a></section>', 5);
assert.equal(notes[0]?.title, "旅行笔记");
assert.equal(new URL(notes[0]!.url).searchParams.get("xsec_token"), "test");
const execution = await createWebSearchTool().resolveExecution({ query: "test" });
if (!("isError" in execution)) await assert.rejects(execution.execute({ toolCallId: "offline", signal: undefined }), /Desktop/);
console.log("web-search tests passed");
