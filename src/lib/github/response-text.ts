/**
 * Byte cap on successful GitHub response bodies, read inside `GitHubGateway.request`.
 *
 * Sits strictly above the write-time reconciliation fact limit
 * (`DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT`, 64 MiB, in
 * `src/lib/fold/evidence-facts.ts` — deliberately referenced in a comment and
 * not imported: importing it would invert the github → fold layering). The one
 * MiB of slack keeps any body whose serialized fact could still pass the
 * write-time limit bufferable here, while anything a caller would accept past
 * 64 MiB is not worth the memory it costs the fold worker.
 */
export const MAX_SUCCESS_BODY_BYTES = 64 * 1024 * 1024 + 1024 * 1024;

/**
 * Thrown when a successful GitHub response body exceeds the success-path byte
 * cap instead of returning a silently-emptied body. Names only the cap: a
 * response body and the access token never enter the message.
 */
export class GitHubResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`GitHub response body exceeded the ${maxBytes}-byte cap.`);
    this.name = "GitHubResponseTooLargeError";
  }
}

/**
 * Reads a response body as text up to `maxBytes` bytes. Returns the decoded
 * text, `""` for a bodyless response, or `null` once the stream passes the
 * cap — the caller decides what `null` means. The stream is always cancelled
 * and the reader released, including on abort and on the over-cap exit.
 */
export async function boundedResponseText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string | null> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const cleanup = () => {
    try {
      // Cancellation may reject or never settle. Initiate it without awaiting it,
      // then release the reader immediately, including when a read is pending.
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup must not replace the read's result or error.
    } finally {
      reader.releaseLock();
    }
  };
  signal.addEventListener("abort", cleanup, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        return content + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        return null;
      }
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cleanup);
    cleanup();
  }
}
