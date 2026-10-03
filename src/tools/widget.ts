import { z } from "zod";
import { WIDGET_GUIDE, WIDGET_MAX_HTML_LENGTH, widgetSchema, type WidgetInput } from "../widgets/widget.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

export function createWidgetRendererTool(): Tool<WidgetInput, WidgetInput & { kind: "widget" }> {
  return {
    name: "WidgetRenderer",
    description: "Render an interactive HTML/SVG visualization inline in chat. Use for simulations, visual explanations, diagrams and dashboards. Read WidgetReadme before the first widget. The HTML runs in a themed, isolated sandbox after successful generation.",
    promptSnippet: "Create streaming interactive visualizations in chat",
    promptGuidelines: ["Use WidgetReadme before creating a widget. Prefer WidgetRenderer when interactive controls help a visual explanation; put scripts after the visual HTML."],
    parameters: { type: "object", properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      description: { type: "string", maxLength: 1_000 },
      html: { type: "string", minLength: 1, maxLength: WIDGET_MAX_HTML_LENGTH, description: "Self-contained HTML/SVG fragment; inline scripts at the end. No remote dependencies." }
    }, required: ["title", "html"], additionalProperties: false },
    schema: widgetSchema,
    capability: "visualization.widget",
    risk: "read",
    resolveExecution(args) {
      return { accesses: ToolAccesses.none(), approvalRule: "WidgetRenderer", retrySafety: "safe",
        display: { kind: "generic", summary: args.title },
        async execute() { return { kind: "widget", ...widgetSchema.parse(args) }; }
      };
    }
  };
}

export function createWidgetReadmeTool(): Tool<Record<string, never>, { guide: string }> {
  return {
    name: "WidgetReadme", description: "Read design, interaction and sandbox guidelines before creating the first widget.",
    parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}).strict(),
    capability: "visualization.widget", risk: "read",
    resolveExecution() {
      return { accesses: ToolAccesses.none(), approvalRule: "WidgetReadme", retrySafety: "safe", async execute() { return { guide: WIDGET_GUIDE }; } };
    }
  };
}
