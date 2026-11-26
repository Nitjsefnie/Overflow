export function validTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}
