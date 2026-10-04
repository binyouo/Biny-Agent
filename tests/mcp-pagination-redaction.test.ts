import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { serializeToolResult } from "../src/session/toolResultArchive.js";
import { redactSensitiveValue } from "../src/utils/secrets.js";

const cursor = Buffer.from(JSON.stringify({ page: 2, record: "fixture-page" })).toString("base64url");
const schema = { type: "object", properties: { pageToken: { type: "string" } }, additionalProperties: false };
const mcpResult = { context: "mcp-result" as const };
const spacedJwtBody = `${Buffer.from('{ "alg": "HS256", "typ": "JWT" }').toString("base64url")}.${Buffer.from('{ "sub": "fixture" }').toString("base64url")}`;
const spacedJwt = `${spacedJwtBody}.${createHmac("sha256", "fixture-only-key").update(spacedJwtBody).digest("base64url")}`;

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-pagination-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let authority: RuntimeEventAuthority | undefined;
let store: CapabilityStore | undefined;
try {
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  store = await CapabilityStore.open(root, authority);
  const input = (id: string, request: Record<string, unknown> = {}) => ({
    capabilityName: "host:mcp:fixture-list", schema, sessionId: "fixture-session", turnId: "fixture-turn",
    toolCallId: id, offerId: id, request
  });
  let executions = 0;
  const firstPayload = { items: [{ id: "first", body: "first page body" }], nextPageToken: cursor, total: 2 };
  const firstInput = input("page-one");
  const first = await store.executeHostCapability(firstInput, async () => { executions += 1; return firstPayload; });
  assert.deepEqual(first, firstPayload, "fresh MCP response must preserve the opaque continuation and body");
  const modelFirst = JSON.parse(serializeToolResult(first, mcpResult)) as typeof firstPayload;
  assert.deepEqual(modelFirst, firstPayload, "the model serializer must not mask the durable continuation again");
  const secondRequest = { pageToken: modelFirst.nextPageToken };
  const second = await store.executeHostCapability(input("page-two", secondRequest), async () => {
    executions += 1;
    assert.equal(secondRequest.pageToken, cursor, "the server receives its original opaque cursor");
    return { items: [{ id: "second", body: "second page body" }], total: 2 };
  });
  assert.equal(second.items[0]?.id, "second");
  assert.deepEqual(store.list("host")[0]?.schema, schema, "pagination input schema must remain intact");
  const replay = await store.executeHostCapability(firstInput, async () => { throw new Error("must not redispatch"); });
  assert.deepEqual(replay, firstPayload);
  store.close();
  authority.close();
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  store = await CapabilityStore.open(root, authority);
  const recovered = await store.executeHostCapability(firstInput, async () => { throw new Error("must not redispatch after reopen"); });
  assert.deepEqual(JSON.parse(serializeToolResult(recovered, mcpResult)), firstPayload);
  assert.equal(executions, 2);

  const envelope = { content: [{ type: "text", text: "first page body" }], structuredContent: firstPayload, isError: false };
  const durableEnvelope = await store.executeHostCapability(input("envelope"), async () => envelope);
  assert.deepEqual(durableEnvelope, envelope);
  assert.deepEqual(JSON.parse(serializeToolResult(durableEnvelope, mcpResult)), envelope);

  const opaqueValues = [
    "sk-fixtureCredential12345", "ghp_fixtureCredential12345", "AKIAFIXTURE12345678",
    "Bearer fixture-credential", "Basic Zml4dHVyZTpwYXNzd29yZA==",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl",
    spacedJwt,
    "access_token=fixture-credential", '{"apiKey":"fixture-credential"}', "Cookie: session=fixture-credential",
    '{"authorization":"fixture-credential"}', '{"cookie":"session=fixture-credential"}', '{"Proxy-Authorization":"fixture-credential"}',
    "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----"
  ];
  for (const [index, value] of opaqueValues.entries()) {
    const result: { nextPageToken: string } = await store.executeHostCapability(input(`credential-${String(index)}`), async () => ({ nextPageToken: value }));
    assert.equal(result.nextPageToken, value, "the ledger preserves host-cleaned opaque values regardless of their shape");
    assert.equal((redactSensitiveValue({ nextPageToken: value }, mcpResult) as Record<string, unknown>).nextPageToken, value);
    const credentialEnvelope: { structuredContent: { nextPageToken: string } } = await store.executeHostCapability(input(`credential-envelope-${String(index)}`), async () => ({ structuredContent: { nextPageToken: value } }));
    assert.equal(credentialEnvelope.structuredContent.nextPageToken, value);
    assert.equal(JSON.parse(serializeToolResult({ structuredContent: { nextPageToken: value } }, mcpResult)).structuredContent.nextPageToken, value);
  }
  const negative = {
    nextPageToken: cursor,
    nested: { nextPageToken: "opaque-nested-value", apiKey: "opaque-api-value", access_token: "opaque-access-value" },
    authorization: "opaque-auth-value", cookie: "opaque-cookie-value", refreshToken: "opaque-refresh-value",
    secretToken: "opaque-secret-value", arbitraryToken: "opaque-arbitrary-value"
  };
  assert.deepEqual(JSON.parse(serializeToolResult(negative, mcpResult)), negative);
  assert.equal(JSON.parse(serializeToolResult({ nextPageToken: "page.two.fixture" }, mcpResult)).nextPageToken, "page.two.fixture");
  const durableNegative = await store.executeHostCapability(input("negative"), async () => negative);
  assert.deepEqual(durableNegative, negative);
  assert.equal(serializeToolResult("token=business-example", mcpResult), "token=business-example");
  assert.equal((redactSensitiveValue({ nextPageToken: cursor }) as Record<string, unknown>).nextPageToken, "[redacted]", "ordinary results do not opt in");
  assert.equal(JSON.parse(serializeToolResult({ nextPageToken: cursor })).nextPageToken, "[redacted]");
  assert.deepEqual(redactSensitiveValue({ nextPageToken: { apiKey: "fixture" } }, mcpResult), { nextPageToken: { apiKey: "fixture" } });
  assert.deepEqual(JSON.parse(serializeToolResult({ records: [{ nextPageToken: cursor }] }, mcpResult)), { records: [{ nextPageToken: cursor }] });
  assert.deepEqual(JSON.parse(serializeToolResult({ metadata: { structuredContent: firstPayload } }, mcpResult)).metadata.structuredContent.nextPageToken, cursor, "host-cleaned nested business data remains intact");
  const plugin = await store.executeHostCapability({ ...input("plugin"), capabilityName: "host:plugin:fixture-list" }, async () => ({ nextPageToken: cursor }));
  assert.equal(plugin.nextPageToken, "[REDACTED]");
  const clientRegistration = store.register({ ownerType: "client", ownerId: "fixture-client", capabilityName: "host:mcp:fixture-client", schema });
  store.admit(clientRegistration.registrationId);
  const clientInvocation = store.invoke({ registrationId: clientRegistration.registrationId, request: {} });
  store.accept(clientInvocation.invocationId);
  store.start(clientInvocation.invocationId);
  const clientResult = store.result(clientInvocation.invocationId, { nextPageToken: cursor });
  assert.deepEqual(clientResult.result, { nextPageToken: "[REDACTED]" }, "a client-controlled MCP-like name is insufficient");
  console.log("MCP pagination redaction tests passed (durable fresh/replay/reopen, model serialization, page-two roundtrip, credential and context controls)");
} finally {
  store?.close();
  authority?.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
