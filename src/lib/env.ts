export function readEnv(name: string): string | undefined {
  return process.env[`OVERFLOW_${name}`] ?? process.env[name];
}
