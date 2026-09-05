export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }

  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && nextIndex < inputs.length) {
      const index = nextIndex++;
      try {
        results[index] = await operation(inputs[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return results;
}
