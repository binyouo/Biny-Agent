/** Model-facing timeout bounds must match the runtime download contract, without dispatch. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserRelayTools } from "../src/tools/browserRelay.js";
import { normalizeToolParameters, openAiCompatibleToolParameters, validateJsonSchema } from "../src/tools/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";

const tools = createBrowserRelayTools();
const registry = new ToolRegistry();
for (const tool of tools) registry.registerBuiltinTool(tool);
const target = { browserId: "e20e99ba-e7c6-48ee-9e8e-aa3f39391d91", tabId: 1 };
const download = { ...target, url: "https://example.com/fixture.txt", path: "fixture.txt" };
const projections = [
  ["catalog", (name: string) => registry.listDefinitions().find(tool => tool.name === name)!.parameters],
  ["normalized", (name: string) => normalizeToolParameters(name, registry.get(name).parameters)],
  ["compatible", (name: string) => openAiCompatibleToolParameters(name, registry.get(name).parameters)]
] as const;

for (const [label, parameters] of projections) {
  for (const timeoutMs of [undefined, 0, 1, 8000, -1, 0.5, 8001, null, "1"]) {
    test(`${label}: download timeout ${String(timeoutMs)} agrees with runtime`, () => {
      const input = timeoutMs === undefined ? download : { ...download, timeoutMs };
      const expected = timeoutMs === undefined || timeoutMs === 1 || timeoutMs === 8000;
      assert.equal(registry.get("ChromeRelayDownload").schema.safeParse(input).success, expected, "existing runtime contract");
      assert.equal(validateJsonSchema(parameters("ChromeRelayDownload"), input).ok, expected, "advertised contract");
    });
  }
  for (const [name, extra] of [
    ["ChromeRelayNavigate", { url: "https://example.com/" }],
    ["ChromeRelayClick", { selector: "#button" }],
    ["ChromeRelayType", { selector: "#field", value: "text" }],
    ["ChromeRelayPress", { key: "Enter" }],
    ["ChromeRelayWait", { state: "load" }],
    ["ChromeRelayUpload", { selector: "#file", paths: ["fixture.txt"] }]
  ] as const) {
    test(`${label}: ${name} retains zero timeout`, () => {
      const input = { ...target, ...extra, timeoutMs: 0 };
      assert.equal(registry.get(name).schema.safeParse(input).success, true);
      assert.equal(validateJsonSchema(parameters(name), input).ok, true);
    });
  }
  test(`${label}: download still requires target, URL and path and forbids extras`, () => {
    for (const key of ["browserId", "tabId", "url", "path"] as const) {
      const input: Record<string, unknown> = { ...download };
      delete input[key];
      assert.equal(registry.get("ChromeRelayDownload").schema.safeParse(input).success, false);
      assert.equal(validateJsonSchema(parameters("ChromeRelayDownload"), input).ok, false);
    }
    const input = { ...download, unexpected: true };
    assert.equal(registry.get("ChromeRelayDownload").schema.safeParse(input).success, false);
    assert.equal(validateJsonSchema(parameters("ChromeRelayDownload"), input).ok, false);
  });
}
