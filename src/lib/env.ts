/**
 * Reads an environment variable with the repository's prefix taking priority.
 *
 * Issue 1320 requires every self-defined variable to carry the OVERFLOW_
 * prefix. Deployments that still set the old name keep working through the
 * fallback, while the prefixed name wins when both are set, even if empty.
 */
export function readEnv(name: string): string | undefined {
  return process.env[`OVERFLOW_${name}`] ?? process.env[name];
}
