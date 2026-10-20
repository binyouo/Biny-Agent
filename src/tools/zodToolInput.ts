import { zodSchema } from "ai";
import type { z } from "zod";
import { normalizeToolParameters, type JsonObjectSchema, type JsonSchema } from "./schema.js";

/** Zod owns local input rules; JSON Schema is the model-facing input projection. */
export function zodToolInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): {
  schema: typeof schema;
  parameters: JsonObjectSchema;
} {
  const generated = zodSchema(schema, { useReferences: false }).jsonSchema as JsonSchema;
  // Function-tool providers require an object root. Keep the complete union and
  // expose its property names without weakening any branch's required fields.
  let parameters: JsonObjectSchema;
  if ("type" in generated && generated.type === "object") parameters = generated;
  else {
    if (!("anyOf" in generated) || !generated.anyOf?.length) throw new Error("Tool input must be an object or a union of objects.");
    const properties: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>;
    for (const branch of generated.anyOf) {
      if (!("type" in branch) || branch.type !== "object") throw new Error("Tool input union branches must be objects.");
      for (const [key, property] of Object.entries(branch.properties ?? {})) {
        const previous = properties[key];
        properties[key] = previous ? { anyOf: [previous, property] } : property;
      }
    }
    parameters = { type: "object", properties, anyOf: generated.anyOf, additionalProperties: false };
  }
  return { schema, parameters: normalizeToolParameters("Zod input", parameters) };
}
