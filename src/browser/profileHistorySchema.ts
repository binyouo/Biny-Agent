import { z } from "zod";

export const browserProfileHistorySchema = z.object({
  profileId: z.string().trim().min(1).max(100),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();

export type BrowserProfileHistoryArgs = z.infer<typeof browserProfileHistorySchema>;
