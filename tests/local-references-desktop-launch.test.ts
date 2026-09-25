/** 桌面单实例启动参数只接受规范引用 URI 和匹配的项目身份。 */
import assert from "node:assert/strict";
import { parseDesktopReferenceLaunch } from "../src/desktop/electron/main/desktopReferenceLaunch.js";

const valid = parseDesktopReferenceLaunch(["Biny", "--biny-ref=biny://thread/t1", "--biny-project=p1"]);
assert.deepEqual(valid, { uri: "biny://thread/t1", projectId: "p1" });
assert.equal(parseDesktopReferenceLaunch(["Biny", "--biny-ref=biny://file/..%2Fsecret", "--biny-project=p1"]), undefined);
assert.equal(parseDesktopReferenceLaunch(["Biny", "--biny-ref=biny://thread/t1"]), undefined);
console.log("local reference desktop launch tests passed");
