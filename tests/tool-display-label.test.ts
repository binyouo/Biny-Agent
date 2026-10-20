/** 工具显示名称不改动执行标识，不猜测带下划线的服务/工具边界。 */
import assert from "node:assert/strict";
import { executionToolLabel } from "../src/desktop/renderer/src/sessionTimeline.js";
assert.equal(executionToolLabel("mcp_Context7_resolve-library-id"), "MCP 工具");
assert.equal(executionToolLabel("mcp_Context7_get-library-docs"), "MCP 工具");
assert.equal(executionToolLabel("mcp_my_server_find_items"), "MCP 工具");
assert.equal(executionToolLabel("Read"), "读取文件");
assert.equal(executionToolLabel("BashOutput"), "后台输出");
assert.equal(executionToolLabel("mcp_"), "mcp_");
console.log("tool display label tests passed");

assert.equal(executionToolLabel("Bash"), "执行命令");
assert.equal(executionToolLabel("exec"), "运行脚本");
assert.equal(executionToolLabel("run_script"), "脚本处理");
assert.equal(executionToolLabel("ToolSearch"), "搜索工具");
assert.equal(executionToolLabel("recall_memory"), "检索记忆");
assert.equal(executionToolLabel("custom_plugin_action"), "custom_plugin_action");
assert.equal(executionToolLabel("constructor"), "constructor");
assert.equal(executionToolLabel("__proto__"), "__proto__");
