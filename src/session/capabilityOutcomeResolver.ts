import { CapabilityIdempotencyConflictError, type CapabilityStore } from "../runtime/CapabilityStore.js";
import type { SensitiveValueRedactionOptions } from "../utils/secrets.js";
import type { SessionReplayOptions } from "./replay.js";

/** Carries host-verified response context only for the exact resolved object. */
export class CapabilityOutcomeResolver {
  private readonly recoveredMcpResults = new WeakSet<object>();

  constructor(private readonly getStore: () => CapabilityStore | undefined) {}

  readonly resolve: NonNullable<SessionReplayOptions["resolveToolOutcome"]> = (call) => {
    const store = this.getStore();
    let invocation;
    try {
      invocation = store?.findHostToolInvocation(call);
    } catch (error) {
      if (!(error instanceof CapabilityIdempotencyConflictError)) throw error;
      return { executionStatus: "unknown", outcomeUnknownReason: "operation_identity_ambiguous", result: { error: error.message } };
    }
    if (!invocation) return undefined;
    const evidence = `capability:${invocation.invocationId}`;
    if (invocation.status === "result") {
      const registration = store!.get(invocation.registrationId);
      if (registration?.ownerType === "host" && registration.ownerId === "host"
        && registration.capabilityName.startsWith("host:mcp:")
        && typeof invocation.result === "object" && invocation.result !== null) {
        this.recoveredMcpResults.add(invocation.result);
      }
      return { executionStatus: "succeeded", result: invocation.result, evidence };
    }
    if (invocation.status === "failed") return { executionStatus: "failed", result: { error: invocation.error ?? "Capability failed." }, evidence };
    if (invocation.status === "cancelled" && invocation.dispatchState === "not_dispatched") return { executionStatus: "cancelled", result: { status: "cancelled", message: "Capability was cancelled before dispatch." }, evidence };
    return {
      executionStatus: "unknown",
      result: { error: invocation.error ?? "Capability outcome is not durably settled; do not repeat its side effects." },
      outcomeUnknownReason: invocation.outcomeUnknownReason ?? "unsettled_previous_invocation",
      evidence
    };
  };

  redactionOptionsFor(result: unknown): SensitiveValueRedactionOptions {
    return typeof result === "object" && result !== null && this.recoveredMcpResults.has(result)
      ? { context: "mcp-result" } : {};
  }
}
