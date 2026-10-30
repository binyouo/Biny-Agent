/** Pure normalization and Electron argument construction; no product imports or cookie I/O. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Cookie = Record<string, unknown>;
interface Api {
  parseCookieJar(raw: string): Cookie[];
  serializeCookieJar(cookies: Cookie[]): string;
  cookieHeaderFor(cookies: Cookie[], url: URL, now: number): string | undefined;
  toCookiesSetDetails(cookie: Cookie): Cookie;
}
function extract(relative: string, names: string[]): string {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(selected.length, names.length);
  const forbidden = new Set(["process", "globalThis", "require", "eval", "Function", "fetch", "fs", "clipboard"]);
  function inspect(node: ts.Node): void {
    if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `Unexpected capability: ${node.text}`);
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) assert.fail("Unexpected import");
    ts.forEachChild(node, inspect);
  }
  selected.forEach(inspect);
  return selected.map(node => node.getText(parsed).replace(/^export\s+/u, "")).join("\n");
}
const code = extract("../src/tools/web/cookieJar.ts", ["parseCookieJar", "serializeCookieJar", "cookieHeaderFor", "domainMatches", "pathMatches", "normalizeCookie", "normalizeSameSite", "isRecord"])
  + "\n" + extract("../src/desktop/electron/main/DesktopBrowserService.ts", ["toCookiesSetDetails", "toElectronSameSite"]);
const api = runInNewContext(stripTypeScriptTypes(code, { mode: "strip" }) + "\n({parseCookieJar,serializeCookieJar,cookieHeaderFor,toCookiesSetDetails})", Object.create(null), {
  timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
}) as Api;
const parse = (changes: Cookie = {}): Cookie => api.parseCookieJar(JSON.stringify({ cookies: [{ name: "sid", value: "synthetic", domain: "app.example", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 20, ...changes }], origins: [] }))[0]!;
const header = (cookie: Cookie, host = "app.example", now = 10_000): string | undefined => api.cookieHeaderFor([cookie], new URL(`https://${host}/`), now);

for (const [label, expires] of [["future", 20], ["fractional", 10.001], ["zero", 0], ["expired", 9], ["boundary", 10]] as const) {
  test(`Playwright ${label} expiry survives normalization and Electron conversion`, () => {
    const cookie = parse({ expires });
    assert.equal(cookie.expirationDate, expires);
    assert.equal(cookie.session, false);
    assert.equal(api.toCookiesSetDetails(cookie).expirationDate, expires);
  });
}
for (const expires of [0, 9, 10]) test(`Playwright expiry ${expires} is not sent at 10 seconds`, () => assert.equal(header(parse({ expires })), undefined));
test("future Playwright cookie remains usable on exact host", () => assert.equal(header(parse()), "sid=synthetic"));
test("Playwright host-only cookie is not sent to subdomain", () => assert.equal(header(parse(), "child.app.example"), undefined));
test("Playwright host-only Electron arguments omit domain", () => assert.equal(api.toCookiesSetDetails(parse()).domain, undefined));
test("Playwright dotted domain still reaches subdomains and Electron", () => {
  const cookie = parse({ domain: ".app.example" });
  assert.equal(header(cookie, "child.app.example"), "sid=synthetic");
  assert.equal(api.toCookiesSetDetails(cookie).domain, ".app.example");
});
test("Playwright session sentinel keeps session lifetime and exact host scope", () => {
  const cookie = parse({ expires: -1 });
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(cookie.session, true);
  assert.equal(header(cookie), "sid=synthetic");
  assert.equal(header(cookie, "child.app.example"), undefined);
  assert.equal(api.toCookiesSetDetails(cookie).expirationDate, undefined);
});
test("Cookie-Editor explicit metadata overrides alternate fields", () => {
  const cookie = parse({ expires: 9, expirationDate: 30.5, hostOnly: false, session: false });
  assert.equal(cookie.expirationDate, 30.5);
  assert.equal(header(cookie, "child.app.example"), "sid=synthetic");
  assert.equal(api.toCookiesSetDetails(cookie).domain, "app.example");
});
for (const domain of ["app.example", ".app.example"]) test(`native Chrome/Electron shape preserved for ${domain}`, () => {
  const input = { name: "sid", value: "synthetic", domain, path: "/", secure: true, httpOnly: true, expirationDate: 30.000001, hostOnly: !domain.startsWith("."), sameSite: "lax", session: false };
  const cookie = api.parseCookieJar(JSON.stringify([input]))[0]!;
  for (const key of Object.keys(input)) assert.equal(cookie[key], input[key as keyof typeof input]);
  assert.equal(api.toCookiesSetDetails(cookie).domain, input.hostOnly ? undefined : domain);
  assert.equal(api.toCookiesSetDetails(cookie).expirationDate, 30.000001);
});
test("legacy metadata-free Cookie-Editor shape retains existing behavior", () => {
  const cookie = parse({ expires: undefined });
  assert.equal(cookie.hostOnly, undefined);
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(header(cookie, "child.app.example"), "sid=synthetic");
});
test("normalization round-trip preserves scope, expiry and unknown fields", () => {
  const cookie = parse({ custom: { retained: true } });
  const restored = api.parseCookieJar(api.serializeCookieJar([cookie]))[0]!;
  assert.equal(JSON.stringify(restored), JSON.stringify(cookie));
  assert.equal(header(restored, "child.app.example"), undefined);
  assert.equal(header(restored, "app.example", 20_000), undefined);
});
test("secure and path matching stay unchanged", () => {
  const cookie = parse({ path: "/docs" });
  assert.equal(api.cookieHeaderFor([cookie], new URL("http://app.example/docs"), 10_000), undefined);
  assert.equal(header(cookie), undefined);
  assert.equal(api.cookieHeaderFor([cookie], new URL("https://app.example/docs/page"), 10_000), "sid=synthetic");
});
for (const wrapper of [false, true]) test(`unknown expires in Cookie-Editor ${wrapper ? 'wrapper' : 'array'} is not reinterpreted`, () => {
  const entry = { name: "sid", value: "synthetic", domain: "app.example", path: "/", secure: true, httpOnly: true, expires: 20 };
  const cookie = api.parseCookieJar(JSON.stringify(wrapper ? { cookies: [entry] } : [entry]))[0]!;
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(cookie.hostOnly, undefined);
  assert.equal(cookie.session, true);
  assert.equal(header(cookie, "child.app.example", 30_000), "sid=synthetic");
  assert.equal(cookie.expires, 20);
});
test("explicit native expirationDate without hostOnly retains legacy domain scope", () => {
  const cookie = parse({ expirationDate: 40 });
  assert.equal(cookie.expirationDate, 40);
  assert.equal(cookie.hostOnly, undefined);
  assert.equal(header(cookie, "child.app.example"), "sid=synthetic");
  assert.equal(api.toCookiesSetDetails(cookie).domain, "app.example");
});
test("explicit session metadata never gains lifetime from unknown expires", () => {
  const cookie = parse({ session: true, hostOnly: true });
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(api.toCookiesSetDetails(cookie).expirationDate, undefined);
  assert.equal(header(cookie, "app.example", 30_000), "sid=synthetic");
  assert.equal(header(cookie, "child.app.example", 30_000), undefined);
});
test("explicit false session metadata also retains existing normalization", () => {
  const cookie = parse({ session: false });
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(cookie.hostOnly, undefined);
  assert.equal(cookie.session, false);
});
test("Cookie-Editor store marker does not opt into Playwright conversion", () => {
  const cookie = parse({ storeId: "0" });
  assert.equal(cookie.expirationDate, undefined);
  assert.equal(cookie.hostOnly, undefined);
  assert.equal(cookie.storeId, "0");
});
