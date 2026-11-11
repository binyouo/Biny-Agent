import { z } from "zod";
import { relayUrlSchema } from "./relayProtocol.js";

export const browserReadSchema = z.object({
  urls: z.array(relayUrlSchema).min(1).max(8).describe("One to eight public HTTP(S) URLs to read concurrently in independent temporary pages."),
  environment: z.string().trim().min(1).max(60).optional().describe("Existing browser environment name, only when the user names one."),
  maxCharacters: z.number().int().min(1_000).max(40_000).optional().describe("Maximum text characters per page; defaults to 16000. Increase when truncated content omits the requested information.")
}).strict();
