/** Replace PostgreSQL's forbidden NUL character throughout forge JSON values. */
export function sanitizeForgeStrings<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "\uFFFD") as T;
  if (Array.isArray(value)) return value.map(sanitizeForgeStrings) as T;
  if (value === null || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const sanitized = Object.create(prototype) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = sanitizeForgeStrings(nested);
  }
  return sanitized as T;
}
