/** Pure source-extracted cookie matching: no product imports, cookie files, browser or HTTP. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly?: boolean;
  expirationDate?: number;
}

type HeaderFor = (cookies: readonly Readonly<Cookie>[], url: URL, now: number) => string | undefined;

function loadHeaderFor(): HeaderFor {
  const fileName = new URL("../src/tools/web/cookieJar.ts", import.meta.url);
  const source = readFileSync(fileName, "utf8");
  const parsed = ts.createSourceFile(fileName.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = ["cookieHeaderFor", "domainMatches", "pathMatches"];
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && wanted.includes(statement.name?.text ?? ""));
  assert.deepEqual(functions.map((declaration) => declaration.name?.text), wanted);
  const allowedCalls = new Set([
    "Date.now", "url.hostname.toLowerCase", "cookies.filter", "domainMatches", "pathMatches",
    "[...matched].sort", "seen.has", "seen.add", "parts.push", "parts.join",
    'cookie.domain.toLowerCase().replace', "cookie.domain.toLowerCase", "cookie.domain.startsWith",
    "host.endsWith", "requestPath.startsWith", "target.endsWith"
  ]);
  const forbiddenIdentifiers = new Set([
    "process", "globalThis", "require", "eval", "Function", "fetch", "WebSocket", "Buffer"
  ]);
  function inspect(node: ts.Node): void {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), "no imports in extracted functions");
    if (ts.isIdentifier(node)) assert.ok(!forbiddenIdentifiers.has(node.text), `forbidden identifier: ${node.text}`);
    if (ts.isCallExpression(node)) {
      assert.ok(allowedCalls.has(node.expression.getText(parsed)), `unexpected extracted call: ${node.expression.getText(parsed)}`);
    }
    if (ts.isNewExpression(node)) assert.equal(node.expression.getText(parsed), "Set", "only the baseline's inert Set allocation is allowed");
    ts.forEachChild(node, inspect);
  }
  for (const declaration of functions) inspect(declaration);
  // Preserve the actual function bodies. Native stripping removes types, not behavior.
  const text = functions.map((declaration) => declaration.getText(parsed).replace(/^export\s+/, "")).join("\n");
  const script = stripTypeScriptTypes(text, { mode: "strip" });
  const result: unknown = runInNewContext(`"use strict";\n${script}\ncookieHeaderFor;`, Object.create(null), {
    timeout: 1_000,
    contextCodeGeneration: { strings: false, wasm: false }
  });
  assert.equal(typeof result, "function");
  return result as HeaderFor;
}

const headerFor = loadHeaderFor();
const now = 10_000;
function cookie(value: string, changes: Partial<Cookie> = {}): Cookie {
  return { name: "sid", value, domain: "app.example", path: "/", secure: true, httpOnly: true, hostOnly: true, ...changes };
}
interface Case {
  name: string;
  cookies: Cookie[];
  url: string;
  expected: string | undefined;
}

const cases: Case[] = [
  {
    name: "same name at root and nested path preserves both in path order",
    cookies: [cookie("root"), cookie("docs", { path: "/docs" })],
    url: "https://app.example/docs/page", expected: "sid=docs; sid=root"
  },
  {
    name: "same name path order is independent of reverse input order",
    cookies: [cookie("docs", { path: "/docs" }), cookie("root")],
    url: "https://app.example/docs/page", expected: "sid=docs; sid=root"
  },
  {
    name: "same name host and parent domains both match with stable equal paths",
    cookies: [cookie("host", { domain: "child.app.example" }), cookie("parent", { domain: ".app.example", hostOnly: false })],
    url: "https://child.app.example/", expected: "sid=host; sid=parent"
  },
  {
    name: "equal path same-name cookies retain reversed domain input order",
    cookies: [cookie("parent", { domain: ".app.example", hostOnly: false }), cookie("host", { domain: "child.app.example" })],
    url: "https://child.app.example/", expected: "sid=parent; sid=host"
  },
  {
    name: "three overlapping same-name cookies are all serialized",
    cookies: [cookie("root"), cookie("section", { domain: ".app.example", hostOnly: false, path: "/docs" }), cookie("leaf", { path: "/docs/api" })],
    url: "https://app.example/docs/api/page", expected: "sid=leaf; sid=section; sid=root"
  },
  {
    name: "different names preserve existing longer-path ordering",
    cookies: [cookie("root", { name: "root" }), cookie("docs", { name: "section", path: "/docs" }), cookie("leaf", { name: "leaf", path: "/docs/api" })],
    url: "https://app.example/docs/api/page", expected: "leaf=leaf; section=docs; root=root"
  },
  {
    name: "equal paths retain stable input order for distinct names",
    cookies: [cookie("one", { name: "z" }), cookie("two", { name: "a" }), cookie("three", { name: "m" })],
    url: "https://app.example/", expected: "z=one; a=two; m=three"
  },
  { name: "host-only cookie matches exact host", cookies: [cookie("host")], url: "https://app.example/", expected: "sid=host" },
  { name: "host-only cookie excludes subdomain", cookies: [cookie("host")], url: "https://child.app.example/", expected: undefined },
  { name: "domain cookie matches subdomain", cookies: [cookie("domain", { domain: ".app.example", hostOnly: false })], url: "https://child.app.example/", expected: "sid=domain" },
  { name: "domain matching requires dot boundary", cookies: [cookie("domain", { domain: ".app.example", hostOnly: false })], url: "https://otherapp.example/", expected: undefined },
  { name: "domain matching excludes unrelated host", cookies: [cookie("host")], url: "https://other.example/", expected: undefined },
  { name: "domain matching is case insensitive", cookies: [cookie("host", { domain: "APP.EXAMPLE" })], url: "https://app.example/", expected: "sid=host" },
  { name: "path matches exact path", cookies: [cookie("docs", { path: "/docs" })], url: "https://app.example/docs", expected: "sid=docs" },
  { name: "path requires slash boundary", cookies: [cookie("docs", { path: "/docs" })], url: "https://app.example/docs-old", expected: undefined },
  { name: "trailing slash path matches descendants", cookies: [cookie("docs", { path: "/docs/" })], url: "https://app.example/docs/page", expected: "sid=docs" },
  { name: "trailing slash path excludes shorter path", cookies: [cookie("docs", { path: "/docs/" })], url: "https://app.example/docs", expected: undefined },
  { name: "query does not alter path matching", cookies: [cookie("docs", { path: "/docs" })], url: "https://app.example/docs?q=value", expected: "sid=docs" },
  { name: "secure cookie omitted on HTTP", cookies: [cookie("secure")], url: "http://app.example/", expected: undefined },
  { name: "nonsecure cookie allowed on HTTP", cookies: [cookie("plain", { secure: false })], url: "http://app.example/", expected: "sid=plain" },
  { name: "cookie valid just before expiration", cookies: [cookie("future", { expirationDate: 10.001 })], url: "https://app.example/", expected: "sid=future" },
  { name: "cookie omitted exactly at expiration", cookies: [cookie("equal", { expirationDate: 10 })], url: "https://app.example/", expected: undefined },
  { name: "cookie omitted after expiration", cookies: [cookie("past", { expirationDate: 9.999 })], url: "https://app.example/", expected: undefined },
  { name: "session cookie has no expiration", cookies: [cookie("session")], url: "https://app.example/", expected: "sid=session" },
  { name: "expired specific path does not suppress valid same-name root", cookies: [cookie("expired", { path: "/docs", expirationDate: 10 }), cookie("root")], url: "https://app.example/docs/page", expected: "sid=root" },
  { name: "empty jar has no Cookie header", cookies: [], url: "https://app.example/", expected: undefined }
];

for (const scenario of cases) {
  test(`cookieHeaderFor: ${scenario.name}`, () => {
    const snapshot = scenario.cookies.map((entry) => ({ ...entry }));
    const input = Object.freeze(scenario.cookies.map((entry) => Object.freeze({ ...entry })));
    const target = new URL(scenario.url);
    const originalUrl = target.href;
    assert.equal(headerFor(input, target, now), scenario.expected);
    assert.deepEqual(input, snapshot, "matching must not mutate input cookies or their ordering");
    assert.equal(target.href, originalUrl, "matching must not mutate the request URL");
  });
}
