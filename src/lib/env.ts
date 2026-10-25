export function readEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[`OVERFLOW_${name}`] ?? env[name];
}
