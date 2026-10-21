/** 浏览器搜索契约：默认 Google、仅两种引擎、可视化偏好可持久化。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";

test("搜索使用 Google/小红书与可视化浏览开关", () => {
  const defaults = configSchema.parse(defaultConfig);
  assert.equal(defaults.web.search.provider, "google");
  assert.equal(defaults.web.search.visibleBrowsing, false);
  const selected = configSchema.parse({ ...defaultConfig, web: { search: { provider: "xiaohongshu", visibleBrowsing: true } } });
  assert.equal(selected.web.search.provider, "xiaohongshu");
  assert.equal(selected.web.search.visibleBrowsing, true);
  for (const provider of ["anysearch", "duckduckgo", "tavily", "brave"]) {
    assert.equal(configSchema.safeParse({ ...defaultConfig, web: { search: { provider } } }).success, false);
  }
});
