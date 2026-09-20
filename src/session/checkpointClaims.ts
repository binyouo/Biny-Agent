/** checkpoint 的可回查视图；来源种类只说明谁说过，绝不自动授予“已验证”状态。 */
import { createHash } from "node:crypto";
import { sessionContextCheckpointFields, type SessionContextCheckpointState, type SessionContextClaimEvidence } from "./metadata.js";

export function checkpointClaims(state: SessionContextCheckpointState, evidence: SessionContextClaimEvidence[] = []) {
  return sessionContextCheckpointFields.flatMap((field) => state[field].map((text, itemIndex) => {
    const references = evidence.find((claim) => claim.field === field && claim.itemIndex === itemIndex)?.references ?? [];
    // schema 解析可能重排对象属性；claim 身份不能随着写盘/恢复的字段顺序变化。
    const referenceKeys = references.map((reference) => JSON.stringify(Object.fromEntries(
      Object.entries(reference).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))
    ))).sort();
    const sources = [...new Set(references.map((ref) => {
      if (ref.kind === "tool_result") return "tool_result";
      if (ref.kind === "tool_call") return "tool_call";
      if (ref.kind === "archive") return "archive";
      if (ref.kind === "checkpoint") return "inherited";
      return ref.role === "user" ? "user_stated" : ref.role === "assistant" ? "assistant_stated" : "unknown";
    }))];
    return {
      id: createHash("sha256").update(JSON.stringify([field, text, referenceKeys])).digest("hex"),
      field, text, sources, verification: "not_verified" as const, references
    };
  }));
}
