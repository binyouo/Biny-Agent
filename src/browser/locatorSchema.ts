import { z } from "zod";

const locatorStepSchema = z.discriminatedUnion("m", [
  z.object({ m: z.literal("locator"), selector: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ m: z.literal("getByRole"), role: z.string().trim().min(1).max(40), name: z.string().max(2_000).optional(), exact: z.boolean().optional() }).strict(),
  z.object({ m: z.literal("getByText"), text: z.string().min(1).max(2_000), exact: z.boolean().optional() }).strict(),
  z.object({ m: z.literal("getByLabel"), label: z.string().min(1).max(2_000) }).strict(),
  z.object({ m: z.literal("getByPlaceholder"), placeholder: z.string().min(1).max(2_000), exact: z.boolean().optional() }).strict(),
  z.object({ m: z.literal("getByTestId"), testId: z.string().min(1).max(512) }).strict(),
  z.object({ m: z.literal("first") }).strict(),
  z.object({ m: z.literal("last") }).strict(),
  z.object({ m: z.literal("nth"), index: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ m: z.literal("filter"), hasText: z.string().min(1).max(2_000) }).strict(),
  z.object({ m: z.literal("visible") }).strict()
]);

const locatorStepsSchema = z.array(locatorStepSchema).min(1).max(20);

export const browserLocatorReadSchema = z.object({
  steps: locatorStepsSchema,
  action: z.discriminatedUnion("m", [
    z.object({ m: z.literal("count") }).strict(),
    z.object({ m: z.literal("isVisible") }).strict(),
    z.object({ m: z.literal("isEnabled") }).strict(),
    z.object({ m: z.literal("textContent") }).strict(),
    z.object({ m: z.literal("innerText") }).strict(),
    z.object({ m: z.literal("getAttribute"), name: z.string().min(1).max(512) }).strict(),
    z.object({ m: z.literal("boundingBox") }).strict(),
    z.object({ m: z.literal("waitFor"), state: z.enum(["attached", "detached", "visible", "hidden"]).optional(), timeoutMs: z.number().int().min(0).max(8_000).optional() }).strict()
  ])
}).strict();

export const browserLocatorActionSchema = z.object({
  steps: locatorStepsSchema,
  action: z.discriminatedUnion("m", [
    z.object({ m: z.literal("click") }).strict(),
    z.object({ m: z.literal("dblclick") }).strict(),
    z.object({ m: z.literal("fill"), value: z.string().max(100_000) }).strict(),
    z.object({ m: z.literal("type"), value: z.string().max(100_000) }).strict(),
    z.object({ m: z.literal("press"), key: z.string().min(1).max(100) }).strict(),
    z.object({ m: z.literal("check") }).strict(),
    z.object({ m: z.literal("uncheck") }).strict(),
    z.object({ m: z.literal("selectOption"), values: z.array(z.string().max(1_000)).min(1).max(100) }).strict()
  ])
}).strict();

export type BrowserLocatorReadArgs = z.infer<typeof browserLocatorReadSchema>;
export type BrowserLocatorActionArgs = z.infer<typeof browserLocatorActionSchema>;
