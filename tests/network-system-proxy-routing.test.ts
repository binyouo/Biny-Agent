/** Actual pure routing + fetch adapter, with inert fetch/dispatcher/system boundaries only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<unknown>;
interface Options { env?: Record<string, string>; platform?: string; systemProxyOutput?: string; baseFetch?: Fetcher; proxyFetch?: Fetcher }
interface Api { createProxyAwareFetch(options?: Options): Fetcher }
function fixture() {
  const source = readFileSync(new URL("../src/network/proxyFetch.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("proxyFetch.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["createProxyAwareFetch", "resolveProxySettings", "parseMacSystemProxy", "parseEnvironmentProxy", "firstEnvironmentValue", "proxyFromScutil", "supportedProxyUrl", "splitNoProxy", "proxyForUrl", "matchesNoProxy", "requestUrl", "requestDispatcher"];
  const functions = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(functions.length, names.length);
  const text = functions.map(node => node.getText(parsed).replace(/^export\s+/u, "")).join("\n");
  assert.ok(!/execFileSync|readFile|setTimeout|setInterval|require\(/u.test(text));
  const calls: Array<{ via: string; input: string; init?: RequestInit }> = [];
  const agents: string[] = [];
  const nativeFetch: Fetcher = async (input, init) => { calls.push({ via: "direct", input: String(input), init }); return "direct"; };
  const proxyFetch: Fetcher = async (input, init) => { calls.push({ via: "proxy", input: String(input), init }); return "proxy"; };
  const sandbox = {
    URL, nativeFetch, fetch: nativeFetch, undiciFetch: proxyFetch,
    process: { env: {}, platform: "linux" },
    readMacSystemProxy: () => { throw new Error("No real system proxy access allowed"); },
    ProxyAgent: class { constructor(url: string) { agents.push(url); } }
  };
  const api = runInNewContext(stripTypeScriptTypes(text, { mode: "strip" }) + "\n({createProxyAwareFetch})", sandbox, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Api;
  return { api, calls, agents, sandbox };
}
function system(changes: Record<string, string | number> = {}, exceptions: string[] = []): string {
  const values = { HTTPEnable: 1, HTTPProxy: "http-proxy.example", HTTPPort: 8080, HTTPSEnable: 1, HTTPSProxy: "https-proxy.example", HTTPSPort: 8443, ...changes };
  return `<dictionary> {\n${Object.entries(values).map(([key, value]) => `  ${key} : ${value}`).join("\n")}\n  ExceptionsList : <array> {\n${exceptions.map((value, i) => `    ${i} : ${value}`).join("\n")}\n  }\n}`;
}
async function route(url: string, changes: Record<string, string | number> = {}, exceptions: string[] = []) {
  const f = fixture();
  const fetcher = f.api.createProxyAwareFetch({ env: {}, platform: "darwin", systemProxyOutput: system(changes, exceptions) });
  await fetcher(url);
  return { via: f.calls[0]?.via, agents: f.agents };
}
for (const scheme of ["http", "https"]) test(`system ${scheme} disabled does not use the other scheme proxy`, async () => {
  const result = await route(`${scheme}://public.example/`, { [scheme === "http" ? "HTTPEnable" : "HTTPSEnable"]: 0 });
  assert.equal(result.via, "direct");
  assert.equal(result.agents.length, 0);
});
for (const scheme of ["http", "https"]) test(`system enabled ${scheme} uses its own proxy`, async () => {
  const result = await route(`${scheme}://public.example/`);
  assert.equal(result.via, "proxy");
  assert.deepEqual(result.agents, [`http://${scheme}-proxy.example:${scheme === "http" ? 8080 : 8443}`]);
});
for (const flag of [1, 2]) for (const scheme of ["http", "https"]) test(`system simple host exclusion ${flag} bypasses ${scheme}`, async () => {
  assert.equal((await route(`${scheme}://server/`, { ExcludeSimpleHostnames: flag })).via, "direct");
});
for (const host of ["server.example", "192.0.2.1", "[2001:db8::1]", "server."]) test(`simple host exclusion does not bypass ${host}`, async () => {
  assert.equal((await route(`https://${host}/`, { ExcludeSimpleHostnames: 1 })).via, "proxy");
});
test("simple hostname remains proxied when checkbox is off", async () => assert.equal((await route("https://server/", { ExcludeSimpleHostnames: 0 })).via, "proxy"));
test("existing explicit exceptions survive simple-host exclusion", async () => assert.equal((await route("https://server.example/", { ExcludeSimpleHostnames: 1 }, ["*.example"])).via, "direct"));
test("both scheme proxies disabled remain direct", async () => assert.equal((await route("https://public.example/", { HTTPEnable: 0, HTTPSEnable: 0 })).via, "direct"));
for (const [key, scheme] of [["HTTP_PROXY", "https"], ["HTTPS_PROXY", "http"]] as const) test(`environment ${key} keeps legacy cross-scheme ${scheme} fallback`, async () => {
  const f = fixture();
  await f.api.createProxyAwareFetch({ env: { [key]: "http://env.example:8000" }, platform: "darwin", systemProxyOutput: system({ ExcludeSimpleHostnames: 1 }) })(`${scheme}://server/`);
  assert.equal(f.calls[0]?.via, "proxy");
  assert.deepEqual(f.agents, ["http://env.example:8000/"]);
});
test("ALL_PROXY and NO_PROXY keep existing environment precedence", async () => {
  const f = fixture();
  const fetcher = f.api.createProxyAwareFetch({ env: { ALL_PROXY: "http://all.example:8000", NO_PROXY: "local.example" }, platform: "darwin", systemProxyOutput: system() });
  await fetcher("https://local.example/"); await fetcher("https://public.example/");
  assert.deepEqual(f.calls.map(x => x.via), ["direct", "proxy"]);
  assert.deepEqual(f.agents, ["http://all.example:8000/"]);
});
test("explicit dispatcher still bypasses automatic proxy agent", async () => {
  const f = fixture(); const dispatcher = {};
  const init = { dispatcher } as RequestInit;
  await f.api.createProxyAwareFetch({ env: {}, platform: "darwin", systemProxyOutput: system() })("https://public.example/", init);
  assert.equal(f.calls[0]?.via, "direct"); assert.equal(f.calls[0]?.init, init); assert.equal(f.agents.length, 0);
});
test("host-injected custom fetch without explicit proxy configuration is untouched", async () => {
  const f = fixture(); const custom: Fetcher = async () => "custom";
  assert.equal(f.api.createProxyAwareFetch({ baseFetch: custom }), custom);
});
test("global fetch replacement retains host override", async () => {
  const f = fixture(); const fetcher = f.api.createProxyAwareFetch({ env: {}, platform: "darwin", systemProxyOutput: system() });
  f.sandbox.fetch = async () => "replacement";
  assert.equal(await fetcher("https://public.example/"), "replacement"); assert.equal(f.agents.length, 0);
});
test("same configured proxy agent is reused", async () => {
  const f = fixture(); const fetcher = f.api.createProxyAwareFetch({ env: {}, platform: "darwin", systemProxyOutput: system() });
  await fetcher("https://one.example/"); await fetcher("https://two.example/");
  assert.equal(f.agents.length, 1); assert.equal(f.calls.length, 2);
});
test("PAC-only configuration remains outside this adapter and never executes a PAC", async () => {
  const f = fixture();
  await f.api.createProxyAwareFetch({ env: {}, platform: "darwin", systemProxyOutput: system({ HTTPEnable: 0, HTTPSEnable: 0, ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "https://pac.example/config.pac" }) })("https://public.example/");
  assert.equal(f.calls[0]?.via, "direct"); assert.equal(f.agents.length, 0);
});
test("explicit baseFetch still owns a disabled system scheme", async () => {
  const f = fixture(); const custom: Fetcher = async () => "custom";
  const fetcher = f.api.createProxyAwareFetch({ baseFetch: custom, env: {}, platform: "darwin", systemProxyOutput: system({ HTTPEnable: 0 }) });
  assert.equal(await fetcher("http://public.example/"), "custom"); assert.equal(f.agents.length, 0);
});
for (const flag of ["", "not-a-number", "Infinity"]) test(`invalid simple-host flag ${JSON.stringify(flag)} keeps proxy routing`, async () => {
  assert.equal((await route("https://server/", { ExcludeSimpleHostnames: flag })).via, "proxy");
});
test("absent simple-host flag keeps proxy routing", async () => assert.equal((await route("https://server/")).via, "proxy"));
for (const host of ["127.1", "2130706433", "0x7f000001"]) test(`IPv4 shorthand ${host} is not a simple hostname bypass`, async () => {
  assert.equal((await route(`https://${host}/`, { ExcludeSimpleHostnames: 1 })).via, "proxy");
});
for (const [key, scheme] of [["http_proxy", "https"], ["https_proxy", "http"], ["all_proxy", "https"]] as const) test(`lowercase ${key} and no_proxy retain environment routing`, async () => {
  const f = fixture();
  const fetcher = f.api.createProxyAwareFetch({ env: { [key]: "http://lower.example:8000", no_proxy: "server" }, platform: "darwin", systemProxyOutput: system() });
  await fetcher(`${scheme}://server/`); await fetcher(`${scheme}://public.example/`);
  assert.deepEqual(f.calls.map(x => x.via), ["direct", "proxy"]);
  assert.deepEqual(f.agents, ["http://lower.example:8000/"]);
});
test("SOCKS-only configuration remains unsupported without HTTP proxy substitution", async () => {
  const result = await route("https://public.example/", { HTTPEnable: 0, HTTPSEnable: 0, SOCKSEnable: 1, SOCKSProxy: "socks.example", SOCKSPort: 1080 });
  assert.equal(result.via, "direct"); assert.equal(result.agents.length, 0);
});
test("WPAD-only configuration remains outside the adapter", async () => {
  const result = await route("https://public.example/", { HTTPEnable: 0, HTTPSEnable: 0, ProxyAutoDiscoveryEnable: 1 });
  assert.equal(result.via, "direct"); assert.equal(result.agents.length, 0);
});
