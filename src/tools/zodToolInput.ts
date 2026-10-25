import { zodSchema } from "ai";
import type { z } from "zod";
import { normalizeToolParameters, type JsonObjectSchema, type JsonSchema } from "./schema.js";

/** Zod owns local input rules; JSON Schema is the model-facing input projection. */
export function zodToolInput<T>(schema: z.ZodType<T, unknown>): {
  schema: typeof schema;
  parameters: JsonObjectSchema;
} {
  const generated = normalizeDisjointUnions(zodSchema(schema, { useReferences: false }).jsonSchema) as JsonSchema;
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
    parameters = { ...generated, type: "object", properties, anyOf: generated.anyOf, additionalProperties: false };
  }
  return { schema, parameters: normalizeToolParameters("Zod input", parameters) };
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep the existing anyOf wire format only when oneOf branches cannot overlap. */
function normalizeDisjointUnions(value: unknown, path = "parameters"): unknown {
  if (!isSchemaRecord(value)) return value;
  const normalized = { ...value };
  if ("oneOf" in value) {
    const branches = value.oneOf;
    if (!Array.isArray(branches) || branches.length === 0 || "anyOf" in value
      || !branches.every((branch): branch is Record<string, unknown> => isSchemaRecord(branch)
        && !("$ref" in branch) && branch.type === "object" && Array.isArray(branch.required)
        && branch.required.every((key) => typeof key === "string") && isSchemaRecord(branch.properties))) {
      throw new Error(`Tool input has unsupported oneOf at ${path}: expected disjoint required string discriminators.`);
    }
    const first = branches[0];
    const discriminator = first && Array.isArray(first.required) && first.required.some((key: unknown) => {
      if (typeof key !== "string") return false;
      const literals = new Set<string>();
      for (const branch of branches) {
        if (!Array.isArray(branch.required) || !branch.required.includes(key) || !isSchemaRecord(branch.properties)) return false;
        const property = branch.properties[key];
        if (!isSchemaRecord(property) || "$ref" in property || property.type !== "string" || typeof property.const !== "string" || literals.has(property.const)) return false;
        literals.add(property.const);
      }
      return true;
    });
    if (!discriminator) throw new Error(`Tool input has unsupported oneOf at ${path}: branches must require distinct string literals for one discriminator.`);
    delete normalized.oneOf;
    normalized.anyOf = branches;
  }
  // Visit only schema-bearing keywords, never literal defaults, consts or examples.
  if (isSchemaRecord(normalized.properties)) {
    normalized.properties = Object.fromEntries(Object.entries(normalized.properties)
      .map(([key, schema]) => [key, normalizeDisjointUnions(schema, `${path}.properties.${key}`)]));
  }
  for (const key of ["items", "additionalProperties"] as const) {
    if (normalized[key] !== undefined) normalized[key] = normalizeDisjointUnions(normalized[key], `${path}.${key}`);
  }
  for (const key of ["anyOf", "allOf"] as const) {
    const branches = normalized[key];
    if (Array.isArray(branches)) normalized[key] = branches.map((schema, index) => normalizeDisjointUnions(schema, `${path}.${key}[${String(index)}]`));
  }
  return normalized;
}
