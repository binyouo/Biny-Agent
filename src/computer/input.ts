import { z } from "zod";
import { computerActionPayload, computerActionPayloadSchema, computerObservationOptions, validateObservationOptions, windowTargetSchema } from "./protocol.js";

type ActionPayload = z.infer<typeof computerActionPayload>;
export const legacyComputerTarget = {
  pid: windowTargetSchema.shape.pid.optional(),
  bundle: z.string().min(1).max(256).optional(),
  window_id: z.number().int().positive().max(4294967295).optional()
};

const aliases: Record<string, keyof ActionPayload> = {
  ref: "elementToken", click_count: "clickCount", coord_space: "coordinateSpace", show_cursor: "showCursor"
};
const actionFields: Record<ActionPayload["action"], string[]> = {
  click: ["ref", "x", "y", "button", "click_count", "strategy", "coord_space"],
  type_text: ["text", "inputMethod", "ref"],
  press_key: ["key"],
  scroll: ["ref", "x", "y", "direction", "pages"],
  drag: ["x1", "y1", "x2", "y2", "coord_space"],
  perform_secondary_action: ["ref", "x", "y"],
  set_value: ["ref", "value"],
  select_text: ["ref", "text", "matchText", "prefix", "suffix", "location", "length"]
};
const requiredFields: Partial<Record<ActionPayload["action"], string[]>> = {
  type_text: ["text"], press_key: ["key"], scroll: ["direction"],
  drag: ["x1", "y1", "x2", "y2"], set_value: ["ref", "value"], select_text: ["ref"]
};

export function legacyActionShape(action: ActionPayload["action"]): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = { ...legacyComputerTarget };
  for (const name of [...actionFields[action], "show_cursor"]) {
    const field = computerActionPayload.shape[aliases[name] ?? name as keyof ActionPayload];
    shape[name] = requiredFields[action]?.includes(name) && field instanceof z.ZodOptional ? field.unwrap() : field;
  }
  return shape;
}

/** 只转换外部字段别名，不解析目标或伪造观察身份。 */
export function legacyActionPayload(action: string, args: Record<string, unknown>): ActionPayload {
  const { pid: _pid, bundle: _bundle, window_id: _window, ...fields } = args;
  return computerActionPayloadSchema.parse({
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [aliases[key] ?? key, value])), action
  });
}

export function legacyObservationOptions(args: Record<string, unknown>): z.infer<typeof computerObservationOptions> {
  const { pid: _pid, bundle: _bundle, window_id: _window, autoLaunch: _autoLaunch, ...options } = args;
  return computerObservationOptions.superRefine(validateObservationOptions).parse(options);
}
