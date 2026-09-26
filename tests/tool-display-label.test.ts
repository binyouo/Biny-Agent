/** 工具显示名称不改动执行标识，不猜测带下划线的服务/工具边界。 */
import assert from "node:assert/strict";
import { executionToolLabel } from "../src/desktop/renderer/src/sessionTimeline.js";
assert.equal(executionToolLabel("mcp_Context7_resolve-library-id"), "Context7 / resolve-library-id");
assert.equal(executionToolLabel("mcp_Context7_get-library-docs"), "Context7 / get-library-docs");
assert.equal(executionToolLabel("mcp_my_server_find_items"), "my / server / find / items");
assert.equal(executionToolLabel("Read"), "Read");
assert.equal(executionToolLabel("BashOutput"), "后台输出");
assert.equal(executionToolLabel("mcp_"), "mcp_");
console.log("tool display label tests passed");
