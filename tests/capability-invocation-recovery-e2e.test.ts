import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { spawnRuntimeHost, terminateSpawnedHost } from "../src/runtime/RuntimeHost.js";

const offerId = "operation-left-running-at-crash";
const abandonedOffers = [
  { invocationId: "invocation-left-admitted-at-crash", offerId: "operation-left-admitted-at-crash", status: "admitted" },
  { invocationId: "invocation-left-accepted-at-crash", offerId: "operation-left-accepted-at-crash", status: "accepted" },
  { invocationId: "invocation-left-running-at-crash", offerId, status: "running" }
] as const;
const request = { value: 13 };
const schema = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false
};

const root = await mkdtemp(path.join(os.tmpdir(), "biny-capability-recovery-e2e-"));
const configDir = path.join(root, "config");
let host: Awaited<ReturnType<typeof spawnRuntimeHost>> | undefined;
try {
  await saveConfig(root, {
    ...structuredClone(defaultConfig),
    defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  }, { globalDir: configDir });

  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const capabilities = await CapabilityStore.open(root, authority);
  const registration = capabilities.register({
    ownerType: "host",
    ownerId: "host",
    capabilityName: "host:mcp:crashed-call",
    schema
  });
  const abandonedInvocationIds = new Map<string, string>();
  for (const abandoned of abandonedOffers) {
    const invocation = capabilities.invoke({
      registrationId: registration.registrationId,
      offerId: abandoned.offerId,
      sessionId: "session-crashed-call",
      turnId: "turn-crashed-call",
      toolCallId: "call-crashed-call",
      request
    }, abandoned.invocationId);
    abandonedInvocationIds.set(abandoned.offerId, invocation.invocationId);
    if (abandoned.status !== "admitted") capabilities.accept(invocation.invocationId);
    if (abandoned.status === "running") capabilities.start(invocation.invocationId);
  }
  capabilities.close();
  authority.close();

  host = await spawnRuntimeHost(root, {
    workspaceRoot: root,
    configDir,
    lifecycleMode: "service",
    idleGraceMs: 10
  });

  const recoveredAuthority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const recoveredCapabilities = await CapabilityStore.open(root, recoveredAuthority);
  try {
    for (const abandoned of abandonedOffers) {
      const recovered = recoveredCapabilities.getInvocation(abandonedInvocationIds.get(abandoned.offerId)!);
      assert.equal(recovered?.status, "unknown", `${abandoned.status} calls must settle before the new owner accepts work`);
      assert.equal(readString(recovered, "outcomeUnknownReason"), "host_restarted");
    }

    let repeatedEffects = 0;
    await assert.rejects(
      recoveredCapabilities.executeHostCapability({
        capabilityName: "host:mcp:crashed-call",
        schema,
        sessionId: "session-crashed-call",
        turnId: "turn-crashed-call",
        toolCallId: "call-crashed-call",
        offerId,
        request
      }, async () => {
        repeatedEffects += 1;
        return { value: 13 };
      }),
      (error: unknown) => readString(error, "code") === "outcome_unknown"
        && readString(error, "reason") === "host_restarted"
        && readBoolean(error, "retrySafe") === false
    );
    assert.equal(repeatedEffects, 0, "an uncertain old offer must not execute again");
  } finally {
    recoveredCapabilities.close();
    recoveredAuthority.close();
  }
} finally {
  await host?.client.close().catch(() => undefined);
  if (host) await terminateSpawnedHost(host.process, 5_000);
  await rm(root, { recursive: true, force: true });
}

console.log("capability invocation recovery e2e tests passed");

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}
