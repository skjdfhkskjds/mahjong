export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object" || !isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function assertJsonValue(
  value: unknown,
  name = "Value",
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${name} must contain only JSON-safe values.`);
  }
}
