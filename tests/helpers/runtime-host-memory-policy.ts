import { memoryPolicySchema, type MemoryPolicy } from "../../src/personalization/index.js";

export function createRuntimeHostMemoryPolicy(): MemoryPolicy {
  // The Host exercises scheduled maintenance while conversational recall and generation stay disabled.
  return memoryPolicySchema.parse({
    enabled: true,
    sleepEnabled: true,
    sleepTime: "00:00",
    useMemories: false,
    generateMemories: false,
    extractModel: undefined,
    excludeExternalContext: true,
    maxRecalled: 3
  });
}
