import { z } from "zod";

export const acpConfigSchema = z.object({
  command: z.string().trim().min(1).max(4_000),
  args: z.array(z.string().max(8_000)).max(100).default([]),
  /** 环境变量保存引用名，不在连接快照中传递凭据值。 */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).default({}),
  promptTimeoutMs: z.number().int().min(100).max(86_400_000).default(1_800_000),
  maxOutputBytes: z.number().int().min(1024).max(67_108_864).default(16_777_216),
  allowMemory: z.boolean().default(false),
  authMethodId: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  mcpServers: z.array(z.string().min(1)).max(64).default([])
}).strict();
export type AcpConfig = z.infer<typeof acpConfigSchema>;
