import { z } from "zod";
import { computerActionPayload, computerActionPayloadSchema, computerObservationOptions, validateObservationOptions, windowTargetSchema } from "./protocol.js";

type ActionPayload = z.infer<typeof computerActionPayload>;
export const legacyComputerTarget = {
  pid: windowTargetSchema.shape.pid.optional(),
  bundle: z.string().min(1).max(256).optional(),
  window_id: z.number().int().positive().max(4294967295).optional()
};

const aliases: Record<string, keyof ActionPayload> = {
  ref: "elementToken", click_count: "clickCount", coord_space: "coordinateSpace", show_cursor: "showCursor", selection_type: "selectionType", secondary_action: "secondaryAction", input_method: "inputMethod",
  start_x: "x1", start_y: "y1", end_x: "x2", end_y: "y2"
};
const actionFields: Record<ActionPayload["action"], string[]> = {
  click: ["ref", "x", "y", "button", "click_count", "strategy", "coord_space"],
  type_text: ["text", "inputMethod", "input_method", "ref"],
  press_key: ["key"],
  scroll: ["ref", "x", "y", "direction", "pages"],
  drag: ["start_x", "start_y", "end_x", "end_y", "x1", "y1", "x2", "y2", "button", "coord_space"],
  perform_secondary_action: ["ref", "x", "y", "coord_space", "secondary_action"],
  set_value: ["ref", "value"],
  select_text: ["ref", "text", "matchText", "prefix", "suffix", "location", "length", "selection_type"]
};
const requiredFields: Partial<Record<ActionPayload["action"], string[]>> = {
  type_text: ["text"], press_key: ["key"], scroll: ["direction"],
  set_value: ["ref", "value"], select_text: ["ref"]
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
  if (action === "type_text" && fields.input_method !== undefined && fields.inputMethod !== undefined) throw new Error("type_text cannot combine input_method and inputMethod");
  if (action === "select_text" && fields.text !== undefined) {
    if (fields.matchText !== undefined) throw new Error("select_text cannot combine text and matchText");
    fields.matchText = fields.text;
    delete fields.text;
  }
  if (action === "drag") {
    for (const [alias, name] of [["start_x", "x1"], ["start_y", "y1"], ["end_x", "x2"], ["end_y", "y2"]] as const) {
      if (fields[alias] !== undefined && fields[name] !== undefined) throw new Error(`drag cannot combine ${alias} and ${name}`);
    }
  }
  return computerActionPayloadSchema.parse({
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [aliases[key] ?? key, value])), action
  });
}

export function legacyObservationOptions(args: Record<string, unknown>): z.infer<typeof computerObservationOptions> {
  const { pid: _pid, bundle: _bundle, window_id: _window, autoLaunch: _autoLaunch, auto_launch: _autoLaunchAlias, ...options } = args;
  for (const [alias, name] of [["interactive_only", "interactiveOnly"], ["screenshot_max_width", "screenshotMaxWidth"]] as const) {
    if (options[alias] !== undefined && options[name] !== undefined) throw new Error(`observation cannot combine ${alias} and ${name}`);
    if (options[alias] !== undefined) options[name] = options[alias];
    delete options[alias];
  }
  if (options.depth === 0) {
    if (options.content !== undefined && options.content !== "image") throw new Error("depth 0 requires image content");
    delete options.depth;
    options.content = "image";
  }
  if (options.depth === undefined && options.content !== "image") options.depth = 6;
  legacyAutoLaunch(args);
  return computerObservationOptions.superRefine(validateObservationOptions).parse(options);
}

export function legacyAutoLaunch(args: Record<string, unknown>): boolean | undefined {
  if (args.autoLaunch !== undefined && args.auto_launch !== undefined) throw new Error("observation cannot combine autoLaunch and auto_launch");
  return z.boolean().optional().parse(args.auto_launch ?? args.autoLaunch);
}
