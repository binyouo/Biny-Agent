/** Actual reference service/URI code; config, filesystem and discovery adapters are inert. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("src/session/localReferences.ts", "utf8");
const javascript = stripTypeScriptTypes(source
  .replace(/^import[\s\S]*?;\n/gmu, "")
  .replace(/^export \{ LocalReferenceGraph \} from .*;\n?/gmu, "")
  .replace(/^export /gmu, ""), { mode: "strip" });
type Kind = "provider" | "model" | "mcp" | "skill" | "agent" | "tool";
interface Reference { kind: string; uri: string; label: string; content: string }
interface Service {
  search(query: string, projectId: string, kind?: Kind, limit?: number, timeZone?: string): Promise<Reference[]>;
  resolve(uri: string, projectId: string): Promise<Reference>;
}

function fixture(kind: Kind, names: string[], loadFailure?: Error) {
  const entries = Object.fromEntries(names.map(name => [name, kind === "provider"
    ? { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", displayName: name }
    : kind === "model" ? { provider: "fixture", model: name, displayName: name } : { command: "inert-mcp" }]));
  const config = { providers: kind === "provider" ? entries : {}, models: kind === "model" ? entries : {},
    extensions: { mcp: kind === "mcp" ? entries : {}, skills: [], subagent: { enabled: kind === "agent", agentPaths: [] } } };
  const functions = runInNewContext(`${javascript}\n({ LocalReferenceService, localReferenceUri, parseLocalReferenceUri });`, {
    path,
    process: { env: {} },
    globalAgentDir: () => "/inert-state",
    projectSessionsDir: () => "/inert-state/sessions",
    lstat: async () => { throw Object.assign(new Error("No fixture sessions"), { code: "ENOENT" }); },
    readdir: async () => [],
    loadSkills: async () => ({ skills: kind === "skill" ? names.map(name => ({ ref: name, name, description: "inert skill" })) : [] }),
    loadSubagentDefinitions: async () => kind === "agent" ? names.map(name => ({ name, description: "inert agent", prompt: "inert prompt" })) : [],
    LocalReferenceGraph: class {
      async pins(): Promise<never[]> { return []; }
      async searchStored(): Promise<never[]> { return []; }
      close(): void {}
    },
    MemoryStorage: class {
      async listEntries(): Promise<{ entries: never[] }> { return { entries: [] }; }
      close(): void {}
    }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as {
    LocalReferenceService: new(options: object) => Service;
    localReferenceUri(reference: { kind: Kind; id: string }): string;
    parseLocalReferenceUri(uri: string): { kind: Kind; id: string };
  };
  const service = new functions.LocalReferenceService({ root: "/inert-state",
    projects: [{ id: "project", name: "Healthy project", path: "/inert-project" }],
    loadConfig: async () => { if (loadFailure) throw loadFailure; return config; },
    runtimeEntries: async () => kind === "tool" ? names.map(name => ({ kind: "tool", id: name, label: name, content: "inert tool" })) : [] });
  return { ...functions, service };
}

for (const kind of ["provider", "model", "mcp"] as const) {
  for (const names of [["team/proxy", "healthy"], ["healthy", "100%"], ["team/proxy", "100%", "healthy"]]) {
    test(`${kind}: unsupported configured names do not discard healthy search results (${names.join(", ")})`, async () => {
      const { service } = fixture(kind, names);
      const results = await service.search("healthy", "project", kind);
      assert.deepEqual(Array.from(results, item => item.uri), [`biny://${kind}/healthy`]);
    });
  }
  test(`${kind}: direct resolution of a healthy object is not poisoned by an unrelated name`, async () => {
    const { service } = fixture(kind, ["team/proxy", "healthy"]);
    const result = await service.resolve(`biny://${kind}/healthy`, "project");
    assert.equal(result.uri, `biny://${kind}/healthy`);
    assert.equal(result.label, "healthy");
  });
  test(`${kind}: combined discovery retains project and healthy configured object`, async () => {
    const { service } = fixture(kind, ["100%", "healthy"]);
    const results = await service.search("healthy", "project", undefined, 30, "UTC");
    assert.ok(results.some(item => item.uri === "biny://project/project"));
    assert.ok(results.some(item => item.uri === `biny://${kind}/healthy`));
  });
  test(`${kind}: unsupported names do not consume result quota`, async () => {
    const { service } = fixture(kind, ["100%", "healthy-one", "team/proxy", "healthy-two", "healthy-three"]);
    const results = await service.search("", "project", kind, 2);
    assert.deepEqual(Array.from(results, item => item.label), ["healthy-one", "healthy-two"]);
  });
  test(`${kind}: all unsupported entries produce an empty result and cannot resolve`, async () => {
    const { service } = fixture(kind, ["100%", "team/proxy"]);
    assert.equal((await service.search("", "project", kind)).length, 0);
    await assert.rejects(service.resolve(`biny://${kind}/missing`, "project"), /Reference object is not available/u);
  });
  test(`${kind}: representable Unicode and punctuation identities remain unchanged`, async () => {
    const names = ["中文", "team:proxy", "healthy (local)"];
    const f = fixture(kind, names);
    assert.deepEqual(Array.from(await f.service.search("", "project", kind), item => f.parseLocalReferenceUri(item.uri).id), names);
    for (const name of names) assert.equal((await f.service.resolve(f.localReferenceUri({ kind, id: name }), "project")).label, name);
  });
}

for (const kind of ["skill", "agent", "tool"] as const) {
  test(`${kind}: the shared adapter preserves healthy entries when an inert discovery ID is unsupported`, async () => {
    const { service } = fixture(kind, ["team/proxy", "healthy", "100%"]);
    assert.deepEqual(Array.from(await service.search("", "project", kind), item => item.uri), [`biny://${kind}/healthy`]);
    assert.equal((await service.resolve(`biny://${kind}/healthy`, "project")).label, "healthy");
  });
}

test("configuration load errors still propagate from explicit and combined discovery", async () => {
  const error = new Error("inert config failure");
  const { service } = fixture("provider", [], error);
  await assert.rejects(service.search("healthy", "project", "provider"), value => value === error);
  await assert.rejects(service.search("healthy", "project", undefined, 30, "UTC"), value => value === error);
});

test("URI validation remains strict; unsupported names are not normalized into another identity", () => {
  const f = fixture("provider", []);
  for (const id of ["team/proxy", "100%", ".", "..", "line\nbreak", "a\\b"]) {
    assert.throws(() => f.localReferenceUri({ kind: "provider", id }));
  }
  for (const uri of ["biny://provider/team%2fproxy", "biny://provider/100%25", "biny://provider/%252e%252e"])
    assert.throws(() => f.parseLocalReferenceUri(uri));
});
