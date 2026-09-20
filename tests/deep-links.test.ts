/** biny:// 深链解析：三种目标，伪造或残缺的链接一律解析失败。 */
import assert from "node:assert/strict";
import { parseBinyDeepLink } from "../src/desktop/renderer/src/deepLinks.js";

function testCompose(): void {
  const link = parseBinyDeepLink("biny://compose?text=%E7%BB%A7%E7%BB%AD%E4%BC%98%E5%8C%96%E8%BF%99%E4%B8%AA%E5%87%BD%E6%95%B0");
  assert.deepEqual(link, { kind: "compose", text: "继续优化这个函数" });
  assert.equal(parseBinyDeepLink("biny://compose?text="), undefined);
  assert.equal(parseBinyDeepLink("biny://compose"), undefined);
}

function testSession(): void {
  assert.deepEqual(parseBinyDeepLink("biny://session?s=abc-123"), { kind: "session", sessionId: "abc-123" });
  assert.equal(parseBinyDeepLink("biny://session"), undefined);
  assert.equal(parseBinyDeepLink("biny://session?s="), undefined);
}

function testSettingsAndReject(): void {
  assert.deepEqual(parseBinyDeepLink("biny://settings"), { kind: "settings" });
  assert.equal(parseBinyDeepLink("https://example.com"), undefined);
  assert.equal(parseBinyDeepLink("biny://unknown-target"), undefined);
  assert.equal(parseBinyDeepLink("biny://"), undefined);
}

testCompose();
testSession();
testSettingsAndReject();
console.log("deep link tests passed");
