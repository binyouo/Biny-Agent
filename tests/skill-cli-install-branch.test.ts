/** Actual CLI/discovery/installation orchestration; only external I/O uses inert adapters. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parseDocument } from "yaml";

function declarations(file: string, names: string[]): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const found = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.name && names.includes(node.name.text)));
  assert.deepEqual(found.map(node => node.name!.text).sort(), [...names].sort());
  return found.map(node => node.getText(source).replace(/^export /u, "")).join("\n");
}

const source = [
  declarations("cli/commands/skills.ts", ["skillInstallCommand"]),
  declarations("extensions/skillDocument.ts", ["parseSkillDocument"]),
  declarations("extensions/skillDiscovery.ts", [
    "discoverSkillRepositories", "discoverRepository", "installDiscoveredSkill", "fetchRepositoryTree",
    "fetchRepositoryTreeWithFallback", "fetchTreeForBranch", "fetchBranchRevision", "fetchDefaultBranch", "isHttp404",
    "fetchJson", "fetchText", "fetchBytes", "boundedResponseText", "boundedResponseBytes", "cancelErrorResponseBody",
    "assertRepository", "isValidOwner", "isValidRepoName", "isValidBranch", "isSafeSkillPath",
    "encodeBranch", "githubRawUrl", "isInsideRepoDirectory", "lastPathSegment", "firstDescriptionLine",
    "truncate", "isInstalledName", "deduplicateSkills", "mapWithConcurrency", "errorMessage", "ensureDirectory"
  ])
].join("\n");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

interface FixtureOptions {
  branch?: string;
  explicit?: string;
  skills?: string[];
  treeDirectory?: string;
  fail?: (url: string, count: number) => number | Error | undefined;
  invalidCommit?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const branch = options.branch ?? "main";
  const skills = options.skills ?? ["demo"];
  const revision = "a".repeat(40);
  const requests: string[] = [];
  const files = new Map<string, string>();
  const publications: Array<{ name: string; revision: string; source: { branch: string; directory: string } }> = [];
  const treeDirectory = options.treeDirectory ?? "skills";
  const documents = Object.fromEntries(skills.map(name => [`${treeDirectory}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Inert example\n---\nInstructions ${name}\n`]));
  const fetcher = async (input: string): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const fail = options.fail?.(url, requests.filter(item => item === url).length);
    if (fail instanceof Error) throw fail;
    if (fail !== undefined) return new Response("failure", { status: fail });
    if (url.endsWith("/repos/example/skills")) return Response.json({ default_branch: branch });
    if (url.includes("/commits/")) {
      const ref = decodeURIComponent(url.split("/commits/")[1]!.split("?")[0]!);
      return ref === branch ? Response.json({ sha: options.invalidCommit ? "invalid" : revision }) : new Response("missing", { status: 404 });
    }
    if (url.includes("/git/trees/")) {
      const ref = url.split("/git/trees/")[1]!.split("?")[0];
      return ref === branch || ref === revision
        ? Response.json({ tree: Object.entries(documents).map(([path, content]) => ({ path, type: "blob", mode: "100644", size: Buffer.byteLength(content) })) })
        : new Response("missing", { status: 404 });
    }
    if (url.startsWith("https://raw.githubusercontent.com/example/skills/")) {
      const rest = url.slice("https://raw.githubusercontent.com/example/skills/".length);
      for (const ref of [branch, revision]) {
        const content = rest.startsWith(`${ref}/`) ? documents[rest.slice(ref.length + 1)] : undefined;
        if (content !== undefined) return new Response(content);
      }
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = vm.createContext({
    URL, Buffer, path, parseDocument, process: { pid: 1 }, console: { log() {} },
    AbortSignal: { timeout: () => undefined },
    githubApiBase: "https://api.github.com", maxRepositories: 32, maxTreeEntries: 4096,
    maxResponseBytes: 12 * 1024 * 1024, maxMetadataBytes: 512 * 1024,
    maxSkillMetadataBytes: 64 * 1024, maxSkillFileBytes: 512 * 1024, maxSkillFiles: 512, maxSkillBytes: 32 * 1024 * 1024,
    getSharedProxyAwareFetch: () => fetcher, defaultManagedSkillRoot: () => "/managed", randomBytes: () => Buffer.alloc(6),
    fs: {
      mkdir: async () => undefined, lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
      writeFile: async (file: string, bytes: Uint8Array) => { assert.ok(!files.has(file)); files.set(file, Buffer.from(bytes).toString("utf8")); },
      readFile: async (file: string) => { assert.ok(files.has(file)); return files.get(file)!; },
      rm: async () => undefined
    },
    diagnoseSkill: async () => ({ checks: [], status: "unverified" }),
    publishSkillVersion: async (value: typeof publications[number]) => { publications.push(value); return value; }
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(compiled, context);
  return {
    requests, publications, files,
    async install(input = options.explicit ?? "example/skills"): Promise<void> {
      const invoke = vm.runInContext("skillInstallCommand", context) as (source: string) => Promise<void>;
      await invoke(input);
    }
  };
}

for (const branch of ["main", "master", "develop"]) {
  test(`implicit repository discovers and installs the same ${branch} branch`, async () => {
    const f = fixture({ branch });
    await f.install();
    assert.equal(f.publications.length, 1);
    assert.equal(f.publications[0]!.source.branch, branch);
    assert.equal(f.publications[0]!.revision, "a".repeat(40));
    assert.equal(f.files.size, 1);
  });
}

test("named selection and explicit directory select one skill from a multi-skill repository", async () => {
  for (const input of ["example/skills@second", "https://github.com/example/skills/tree/develop/skills/second"]) {
    const f = fixture({ branch: "develop", skills: ["first", "second"] });
    await f.install(input);
    assert.equal(f.publications[0]!.name, "second");
    assert.equal(f.publications[0]!.source.directory, "skills/second");
    assert.equal(f.publications[0]!.source.branch, "develop");
  }
});

test("ambiguous and unknown skill selections never publish", async () => {
  for (const input of ["example/skills", "example/skills@missing"]) {
    const f = fixture({ skills: ["first", "second"] });
    await assert.rejects(f.install(input), /Choose a Skill|Skill not found/u);
    assert.equal(f.publications.length, 0);
  }
});

test("an explicit missing branch is not replaced by the default branch", async () => {
  const f = fixture({ branch: "master" });
  await assert.rejects(f.install("https://github.com/example/skills/tree/main/skills/demo"), /404/u);
  assert.equal(f.requests.length, 1);
  assert.equal(f.publications.length, 0);
});

test("a branch disappearing after discovery cannot switch installation to another branch", async () => {
  const f = fixture({ branch: "main", fail: url => url.includes("/commits/") ? 404 : undefined });
  await assert.rejects(f.install("https://github.com/example/skills/tree/main/skills/demo"), /404/u);
  assert.equal(f.requests.some(url => url.includes("master") || url.endsWith("/repos/example/skills")), false);
  assert.equal(f.publications.length, 0);
});

for (const branch of ["main", "master", "develop"]) {
  test(`implicit ${branch} selection stays bound if the branch disappears before installation`, async () => {
    const f = fixture({ branch, fail: (url, count) => url.includes(`/commits/${branch}?`) && count === 2 ? 404 : undefined });
    await assert.rejects(f.install(), /404/u);
    assert.equal(f.publications.length, 0);
    assert.ok(f.requests.at(-1)?.includes(`/commits/${branch}?`));
    assert.equal(f.requests.filter(url => url.endsWith("/repos/example/skills")).length, branch === "develop" ? 1 : 0);
  });
}

test("an existing main without a skill does not fall back to another branch", async () => {
  const f = fixture({ skills: [] });
  await assert.rejects(f.install(), /Skill not found/u);
  assert.equal(f.requests.some(url => url.includes("master") || url.endsWith("/repos/example/skills")), false);
  assert.equal(f.publications.length, 0);
});

for (const status of [404, 500]) {
  test(`tree HTTP ${status} after resolving main is not missing-branch evidence`, async () => {
    const f = fixture({ fail: url => url.includes("/git/trees/") ? status : undefined });
    await assert.rejects(f.install(), new RegExp(String(status), "u"));
    assert.equal(f.requests.some(url => url.includes("master") || url.endsWith("/repos/example/skills")), false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.publications.length, 0);
  });
}

test("master tree 404 after missing main cannot fall through to the repository default", async () => {
  const f = fixture({ branch: "master", fail: url => url.includes("/git/trees/") ? 404 : undefined });
  await assert.rejects(f.install(), /404/u);
  assert.equal(f.requests.some(url => url.endsWith("/repos/example/skills")), false);
  assert.equal(f.requests.length, 3);
  assert.equal(f.publications.length, 0);
});

for (const failure of [403, 429, 500, new Error("network unavailable")]) {
  test(`implicit discovery does not fall back on ${String(failure)}`, async () => {
    const f = fixture({ fail: () => failure });
    await assert.rejects(f.install(), /403|429|500|network unavailable/u);
    assert.equal(f.requests.length, 1);
    assert.equal(f.publications.length, 0);
  });
}

test("default-branch metadata errors are preserved rather than hidden by previous 404s", async () => {
  const f = fixture({ branch: "develop", fail: url => url.endsWith("/repos/example/skills") ? 500 : undefined });
  await assert.rejects(f.install(), /500/u);
  assert.equal(f.publications.length, 0);
});

test("invalid commit metadata cannot be treated as a missing branch", async () => {
  const f = fixture({ invalidCommit: true });
  await assert.rejects(f.install(), /SHA/u);
  assert.equal(f.requests.some(url => url.includes("master") || url.endsWith("/repos/example/skills")), false);
  assert.equal(f.publications.length, 0);
});
