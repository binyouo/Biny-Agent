/** 按当前 checkpoint 的 claim ID 回查原文；会话和文件目标完全由宿主闭包绑定。 */
import { z } from "zod";
import { ToolAccesses } from "../tools/access.js";
import type { Tool } from "../tools/types.js";

const schema = z.object({
  claimId: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  length: z.number().int().min(1).max(16_000).optional()
}).strict();
export type CheckpointEvidenceArgs = z.infer<typeof schema>;

export function createCheckpointEvidenceTool(read: (args: CheckpointEvidenceArgs, signal?: AbortSignal) => Promise<unknown>): Tool {
  return {
    name: "read_checkpoint_evidence",
    description: "Read the original evidence for a claim in the current context checkpoint. Use the claim id from the checkpoint. Sources describe provenance, not verified completion. Page with offset when hasMore is true.",
    promptSnippet: "Read original session evidence for a checkpoint claim",
    source: "builtin",
    capability: "toolresult.read",
    risk: "read",
    parameters: {
      type: "object",
      properties: {
        claimId: { type: "string", minLength: 64, maxLength: 64, description: "The hexadecimal claim id from the current checkpoint." },
        offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        length: { type: "integer", minimum: 1, maximum: 16_000 }
      },
      required: ["claimId"], additionalProperties: false
    },
    schema,
    resolveExecution(input) {
      const args = schema.parse(input);
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Read checkpoint evidence", detail: args.claimId },
        description: "Read evidence from the current session",
        approvalRule: "read_checkpoint_evidence",
        execute: ({ signal }) => read(args, signal)
      };
    }
  };
}
