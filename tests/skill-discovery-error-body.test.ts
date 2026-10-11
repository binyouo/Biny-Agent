import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSkillRepositories, installDiscoveredSkill, searchSkillsSh } from "../src/extensions/skillDiscovery.js";

async function timely<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP result delayed by cleanup")), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

function errorResponse(behavior: "resolve" | "reject" | "pending" | "throw", status = 503) {
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() {
    canceled++;
    if (behavior === "reject") return Promise.reject(new Error("cleanup rejected"));
    if (behavior === "throw") throw new Error("cleanup threw");
    if (behavior === "pending") return new Promise<void>(() => {});
  } });
  return { response: new Response(body, { status }), canceled: () => canceled };
}

// Public search API: shared verbatim with the isolated source-extraction regression.
for (const behavior of ["resolve", "reject", "pending", "throw"] as const) {
  test(`search preserves HTTP error when body cancellation ${behavior}`, async () => {
    const remote = errorResponse(behavior);
    await assert.rejects(timely(searchSkillsSh({ query: "demo", fetcher: async () => remote.response })), { message: "远程服务返回 HTTP 503。" });
    assert.equal(remote.canceled(), 1);
  });
}

test("search preserves null-body HTTP errors and normal JSON results", async () => {
  await assert.rejects(searchSkillsSh({ query: "demo", fetcher: async () => new Response(null, { status: 404 }) }), { message: "远程服务返回 HTTP 404。" });
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"query":"demo","count":0,"skills":[]}')); controller.close(); },
    cancel() { canceled++; }
  });
  assert.deepEqual(await searchSkillsSh({ query: "demo", fetcher: async () => new Response(body) }), { query: "demo", totalCount: 0, skills: [] });
  assert.equal(canceled, 0);
});
test("search preserves HTTP error when custom body cancel throws synchronously", async () => {
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "cancel", { value() { canceled++; throw new Error("synchronous cancellation failure"); } });
  await assert.rejects(timely(searchSkillsSh({ query: "demo", fetcher: async () => new Response(body, { status: 503 }) })), { message: "远程服务返回 HTTP 503。" });
  assert.equal(canceled, 1);
});
// End isolated public search regression.

const repository = { owner: "fixture", name: "skills", branch: "main", enabled: true };
const skill = { name: "demo", directory: "demo", repoOwner: repository.owner, repoName: repository.name, repoBranch: repository.branch };

test("discovery cancels failed document bodies and preserves skip policy", async () => {
  const remote = errorResponse("pending");
  const result = await timely(discoverSkillRepositories({ repositories: [repository], fetcher: async (input) => {
    if (String(input).includes("/git/trees/")) return Response.json({ tree: [{ path: "demo/SKILL.md", type: "blob" }] });
    return remote.response;
  } }));
  assert.deepEqual(result, { skills: [], warnings: [] });
  assert.equal(remote.canceled(), 1);
});

test("installation cancels main/master 404 bodies before default-branch fallback", async () => {
  const main = errorResponse("pending", 404); const master = errorResponse("reject", 404);
  const requests: string[] = [];
  await assert.rejects(timely(installDiscoveredSkill({ skill, fetcher: async (input) => {
    const url = String(input); requests.push(url);
    if (url.includes("/commits/main?")) return main.response;
    if (url.includes("/commits/master?")) return master.response;
    if (url.endsWith("/skills")) return Response.json({ default_branch: "develop" });
    if (url.includes("/commits/develop?")) return Response.json({ sha: "a".repeat(40) });
    if (url.includes("/git/trees/")) return Response.json({ tree: [] });
    throw new Error(`Unexpected fixture request: ${url}`);
  } })), { message: "仓库中找不到所选 Skill 目录：demo，请刷新目录后重新选择。" });
  assert.equal(requests.length, 5); assert.equal(main.canceled(), 1); assert.equal(master.canceled(), 1);
});

for (const behavior of ["resolve", "reject", "pending", "throw"] as const) {
  test(`installation preserves binary download HTTP error when cancellation ${behavior}`, async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "biny-skill-error-body-"));
    const remote = errorResponse(behavior);
    try {
      await assert.rejects(timely(installDiscoveredSkill({ skill, homeDir, fetcher: async (input) => {
        const url = String(input);
        if (url.includes("/commits/main?")) return Response.json({ sha: "a".repeat(40) });
        if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "demo/SKILL.md", type: "blob", size: 100 }] });
        if (url.endsWith("/demo/SKILL.md")) return remote.response;
        throw new Error(`Unexpected fixture request: ${url}`);
      } })), { message: "远程文件返回 HTTP 503。" });
      assert.equal(remote.canceled(), 1);
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
}
