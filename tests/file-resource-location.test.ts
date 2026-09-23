/** 文件卡片按路径展示位置；日记与其它全局文件使用相同规则。 */
import assert from "node:assert/strict";
import { fileResourceLocation } from "../src/desktop/renderer/src/fileResourceLocation.js";
assert.equal(fileResourceLocation("/Users/example/.config/biny/memory/2026-09-22.md"), "全局");
assert.equal(fileResourceLocation("src/app.ts"), "项目");
assert.equal(fileResourceLocation("/tmp/.config/example.md"), "临时");
assert.equal(fileResourceLocation("C:\\Users\\example\\AppData\\Roaming\\biny\\memory\\2026-09-22.md"), "全局");
assert.equal(fileResourceLocation("/Users/example/Documents/output.md"), undefined);
assert.equal(fileResourceLocation("../outside.md"), undefined);
console.log("file resource location tests passed");
