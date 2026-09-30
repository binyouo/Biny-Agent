import { z } from "zod";
import type * as CuaSdk from "@trycua/cua-driver";
import { computerImageSchema } from "./protocol.js";
import type { DriverReply } from "./controller.js";

export function parseCuaReply(result: CuaSdk.ToolResult): DriverReply {
  const raw: unknown = JSON.parse(result.structuredJson ?? result.rawJson);
  const envelope = z.record(z.unknown()).parse(raw);
  const data = z.record(z.unknown()).parse(envelope.structuredContent ?? envelope);
  const action = result.action;
  const effectNames = ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"];
  return {
    data: action ? { ...data, effect: effectNames[action.effect] ?? "unverifiable", code: action.error?.code } : data,
    images: z.array(computerImageSchema).max(1).parse(result.images),
    errorCode: result.isError ? result.errorCode ?? (typeof data.code === "string" ? data.code : "driver_refused") : undefined
  };
}
