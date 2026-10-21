export function readSetting(value: unknown, key?: string): unknown {
  if (key === undefined) return value;
  let current = value;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) throw new Error(`Unknown setting: ${key}`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function writeSetting<T extends object>(value: T, key: string, next: unknown): T {
  const result = structuredClone(value);
  const parts = key.split(".");
  const last = parts.pop()!;
  const parent = readSetting(result, parts.length ? parts.join(".") : undefined);
  if (typeof parent !== "object" || parent === null) throw new Error(`Unknown setting: ${key}`);
  Object.defineProperty(parent, last, { value: next, enumerable: true, writable: true, configurable: true });
  return result;
}
