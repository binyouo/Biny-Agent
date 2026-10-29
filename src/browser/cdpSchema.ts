import { z } from "zod";

export const maxBrowserCdpParameterBytes = 16 * 1024;

export const browserCdpSchema = z.object({
  method: z.string().min(3).max(128).regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/),
  params: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((args, context) => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args.params ?? {});
  } catch {
    context.addIssue({ code: "custom", path: ["params"], message: "CDP parameters must be JSON serializable." });
    return;
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBrowserCdpParameterBytes) {
    context.addIssue({ code: "custom", path: ["params"], message: "CDP parameters exceed the 16 KiB limit." });
  }
});
