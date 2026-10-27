export const OUTSIDE_REPOSITORY_MARK_LABEL = "overflow: asks outside repository";

export function asksOutsideRepository(labels: readonly string[]): boolean {
  return labels.includes(OUTSIDE_REPOSITORY_MARK_LABEL);
}
