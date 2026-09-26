/** Replace PostgreSQL's forbidden NUL character throughout forge JSON values. */
export function sanitizeForgeStrings<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value) as T;
  }
  if (Array.isArray(value)) {
    let sanitized: unknown[] | undefined;
    value.forEach((nested, index) => {
      const replacement = sanitizeForgeStrings(nested);
      if (replacement !== nested) {
        sanitized ??= value.slice();
        sanitized[index] = replacement;
      }
    });
    return (sanitized ?? value) as T;
  }
  if (value === null || typeof value !== "object") return value;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  let sanitized: Record<string, unknown> | undefined;
  for (const [key, nested] of Object.entries(value)) {
    const replacement = sanitizeForgeStrings(nested);
    if (replacement !== nested) {
      const copy = sanitized ?? { ...(value as Record<string, unknown>) };
      if (sanitized === undefined && prototype === null) Object.setPrototypeOf(copy, null);
      copy[key] = replacement;
      sanitized = copy;
    }
  }
  return (sanitized ?? value) as T;
}
