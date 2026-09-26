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

test("旧 API 服务迁到 Google，旧搜索密钥不进入新配置", async () => {
  const { migrateGlobalConfigDocument } = await import("../src/config/migrations.js");
  const document = { ...defaultConfig, web: { ...defaultConfig.web, search: { enabled: true, provider: "tavily", apiKey: "unused-test-secret", apiKeyEnv: "UNUSED_KEY", timeoutMs: 8_000, maxResults: 6 } } };
  const migrated = configSchema.parse(migrateGlobalConfigDocument(document).document);
  assert.equal(migrated.web.search.provider, "google");
  assert.equal(migrated.web.search.maxResults, 6);
  assert.equal(migrated.web.search.visibleBrowsing, false);
  assert.ok(!JSON.stringify(migrated.web.search).includes("unused-test-secret"));
  assert.equal(document.web.search.provider, "tavily", "纯迁移不修改输入对象");
});
