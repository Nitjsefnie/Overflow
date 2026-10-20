/** Drain started reads before their caller snapshots cost, retaining the first rejection. */
export async function drainIssueReads<T extends readonly unknown[] | []>(
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  try {
    return await Promise.all(reads);
  } catch (error) {
    await Promise.allSettled(reads);
    throw error;
  }
}
