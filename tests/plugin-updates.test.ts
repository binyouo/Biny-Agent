import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePluginVersions, pluginUpdateVersion } from "../src/desktop/renderer/src/components/settings/pluginUpdates.js";
import type { DesktopPluginMarketEntry, DesktopPluginSummary } from "../src/desktop/protocol.js";

const comparisons: Array<{ left: string; right: string; expected: number }> = [
  { left: "1.10.0", right: "1.9.0", expected: 1 },
  { left: "0.7.9", right: "0.7.7", expected: 1 },
  { left: "1.0.0", right: "1.0.0", expected: 0 },
  { left: "1.0", right: "1.0.0", expected: 0 },
  { left: "v2.0.0", right: "1.9.9", expected: 1 },
  { left: "1.0.0", right: "1.0.0-beta", expected: 1 },
  { left: "1.0.0-rc.2", right: "1.0.0-rc.10", expected: -1 },
  { left: "0.1.0", right: "0.2.0", expected: -1 },
  { left: "1.0.0+build.2", right: "1.0.0+build.1", expected: 0 },
  { left: "1.0.0-beta.2", right: "1.0.0-beta.alpha", expected: -1 },
  { left: "1.0.0-alpha", right: "1.0.0-alpha.0", expected: -1 },
  { left: "unknown", right: "1.0.0", expected: 0 }
];
for (const { left, right, expected } of comparisons) {
  test(`comparePluginVersions(${left}, ${right})`, () => {
    assert.equal(Math.sign(comparePluginVersions(left, right)), expected);
  });
}

function market(version: string, id = "demo"): DesktopPluginMarketEntry[] {
  return [{ id, name: "Demo", version, category: "Tools", description: "", details: "", tags: [],
    repository: "https://github.com/example/demo", path: "plugins/demo", featured: false }];
}

function installed(overrides: Partial<DesktopPluginSummary> = {}): DesktopPluginSummary {
  return { id: "x", name: "demo", path: ".biny/plugins/demo", scope: "project", status: "configured",
    moduleCount: 1, managed: true, enabled: true, pluginId: "demo", version: "1.0.0", ...overrides };
}

test("pluginUpdateVersion reports only a strictly newer market version for managed plugins", () => {
  assert.equal(pluginUpdateVersion(installed(), market("1.2.0")), "1.2.0");
  assert.equal(pluginUpdateVersion(installed(), market("1.0.0")), undefined);
  assert.equal(pluginUpdateVersion(installed(), market("0.9.0")), undefined);
  assert.equal(pluginUpdateVersion(installed({ managed: false }), market("1.2.0")), undefined);
  assert.equal(pluginUpdateVersion(installed({ pluginId: undefined }), market("1.2.0")), undefined);
  assert.equal(pluginUpdateVersion(installed(), []), undefined);
  assert.equal(pluginUpdateVersion(installed(), market("1.2.0", "other")), undefined);
});
