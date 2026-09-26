/**
 * Reads the request body chunk by chunk under limitBytes, returning the
 * concatenated bytes, or null once the running byte count crosses the limit.
 *
 * The comparison is strict-greater: a body of exactly limitBytes is accepted.
 * The reader is cancelled on the crossing chunk — never drained to completion
 * — so a missing, unparsable, or inaccurate Content-Length cannot bypass the
 * ceiling, and an oversized body never forces more than limitBytes plus one
 * chunk into memory.
 *
 * A Content-Length header declaring more than limitBytes answers null before
 * a single byte is read, so an honestly declared oversize costs nothing to
 * reject. A declaration that is missing or not a non-negative safe integer is
 * ignored and left to the streaming count, which enforces the limit
 * regardless of what the header claimed.
 *
 * A request with no body at all (request.body === null) reads as the empty
 * byte string.
 */
export async function readBodyWithinLimit(
  request: Request,
  limitBytes: number,
): Promise<Buffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
      && declaredBytes > limitBytes
    ) {
      return null;
    }
  }
  if (request.body === null) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let read = await reader.read();
  while (!read.done) {
    const chunk = read.value;
    totalBytes += chunk.byteLength;
    if (totalBytes > limitBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
    read = await reader.read();
  }
  return Buffer.concat(chunks);
}
