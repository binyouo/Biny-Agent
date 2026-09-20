/**
 * 工具 JSON Schema 模块。
 *
 * 这里维护给模型看的 function parameters 结构，并提供 agent loop 执行前的最小校验。
 * 当前只实现项目内工具需要的 JSON Schema 子集，避免额外引入校验依赖。
 */
export type JsonSchema =
  | JsonObjectSchema
  | JsonStringSchema
  | JsonNumberSchema
  | JsonBooleanSchema
  | JsonArraySchema;

export interface JsonObjectSchema {
  type: "object";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface JsonStringSchema {
  type: "string";
  description?: string;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
}

export interface JsonNumberSchema {
  type: "number" | "integer";
  description?: string;
  minimum?: number;
  maximum?: number;
}

export interface JsonBooleanSchema {
  type: "boolean";
  description?: string;
}

export interface JsonArraySchema {
  type: "array";
  description?: string;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface JsonSchemaValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Provider 只应看到结构稳定的工具 Schema。所有 object 节点都显式携带 string[] `required`；
 * 缺失时补空数组，畸形值在本地带工具名和节点路径失败，不能静默改写。
 */
export function normalizeToolParameters(toolName: string, parameters: JsonSchema): JsonObjectSchema {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || parameters.type !== "object") {
    throw new Error(`Tool ${toolName} has invalid JSON Schema at parameters.type: expected object.`);
  }
  return normalizeSchemaNode(parameters, toolName, "parameters", new WeakSet<object>()) as JsonObjectSchema;
}

/**
 * 自定义 OpenAI-compatible 网关对空 `required` 的实现并不一致。Schema 先按统一规则
 * 完成严格校验，再在该 wire 边界省略语义等价的空数组；非法值仍会在本地直接失败。
 */
export function openAiCompatibleToolParameters(toolName: string, parameters: JsonSchema): JsonObjectSchema {
  return omitEmptyRequired(normalizeToolParameters(toolName, parameters)) as JsonObjectSchema;
}

function normalizeSchemaNode(value: unknown, toolName: string, path: string, ancestors: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) throw new Error(`Tool ${toolName} has a cyclic JSON Schema at ${path}.`);

  ancestors.add(value);
  try {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...source };
    if (source.type === "object") {
      const required = source.required;
      if (required !== undefined && (!Array.isArray(required) || required.some((item) => typeof item !== "string"))) {
        throw new Error(`Tool ${toolName} has invalid JSON Schema at ${path}.required: expected string[].`);
      }
      normalized.required = required === undefined ? [] : [...required];
    }
    if (typeof source.properties === "object" && source.properties !== null && !Array.isArray(source.properties)) {
      normalized.properties = Object.fromEntries(Object.entries(source.properties)
        .map(([key, schema]) => [key, normalizeSchemaNode(schema, toolName, `${path}.properties.${key}`, ancestors)]));
    }
    if (source.items !== undefined) {
      normalized.items = normalizeSchemaNode(source.items, toolName, `${path}.items`, ancestors);
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const alternatives = source[key];
      if (Array.isArray(alternatives)) {
        normalized[key] = alternatives.map((schema, index) => normalizeSchemaNode(schema, toolName, `${path}.${key}[${String(index)}]`, ancestors));
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function omitEmptyRequired(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitEmptyRequired(item));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source)
    .filter(([key, child]) => key !== "required" || !Array.isArray(child) || child.length > 0)
    .map(([key, child]) => [key, omitEmptyRequired(child)]));
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "arguments"): JsonSchemaValidationResult {
  const errors: string[] = [];
  validateValue(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function validateValue(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  switch (schema.type) {
    case "object":
      validateObject(schema, value, path, errors);
      return;
    case "string":
      validateString(schema, value, path, errors);
      return;
    case "number":
    case "integer":
      validateNumber(schema, value, path, errors);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
      return;
    case "array":
      validateArray(schema, value, path, errors);
      return;
  }
}

function validateObject(schema: JsonObjectSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in record)) errors.push(`${path}.${key} is required`);
  }

  for (const [key, field] of Object.entries(record)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      continue;
    }
    validateValue(propertySchema, field, `${path}.${key}`, errors);
  }
}

function validateString(schema: JsonStringSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path} must contain at least ${String(schema.minLength)} character(s)`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${path} must contain at most ${String(schema.maxLength)} character(s)`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
}

function validateNumber(schema: JsonNumberSchema, value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(`${path} must be a ${schema.type}`);
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${String(schema.minimum)}`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${String(schema.maximum)}`);
}

function validateArray(schema: JsonArraySchema, value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${path} must contain at least ${String(schema.minItems)} item(s)`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${String(schema.maxItems)} item(s)`);
  }
  if (!schema.items) return;
  value.forEach((item, index) => validateValue(schema.items as JsonSchema, item, `${path}[${String(index)}]`, errors));
}
