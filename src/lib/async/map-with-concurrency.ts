export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const total = inputs.length;
  const results = new Array<Output>(total);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && nextIndex < total) {
      const index = nextIndex++;
      try {
        results[index] = await operation(inputs[index]);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  if (failed) throw firstError;
  return results;
}
