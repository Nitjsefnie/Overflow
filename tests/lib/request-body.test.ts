import { describe, expect, it } from "vitest";
import { readBodyWithinLimit } from "@/lib/http/request-body";

// The reader takes the limit as a parameter, so the unit tests pin the
// reader's own semantics at small limits — strict-greater crossing,
// cancel-not-drain, the declared-size pre-check, and the null-body-to-empty
// rule — without allocating 25 MiB per case. The webhook routes' 25 MiB
// values and their response ordering are pinned by the route suites
// (tests/api/webhook*.test.ts).
const LIMIT_BYTES = 10;

// A Request whose body is a ReadableStream requires declaring the duplex
// direction; undici sets no Content-Length for a stream body unless one is
// declared explicitly in the headers.
function streamRequest(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://overflow.test/upload", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
}

// Reads are tracked on the stream itself with highWaterMark 0: pull runs only
// when the consumer actually reads (zero pulls at construction or on
// getReader), so handedOutBytes counts bytes the reader pulled and never a
// queue refill it never asked for — "zero bytes pulled" stays exact.
function trackedStream(chunkByteLengths: readonly number[]): {
  stream: ReadableStream<Uint8Array>;
  record: { handedOutBytes: number; cancelled: boolean };
} {
  let chunksSent = 0;
  const record = { handedOutBytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (chunksSent >= chunkByteLengths.length) {
          controller.close();
          return;
        }
        const byteLength = chunkByteLengths[chunksSent];
        controller.enqueue(new Uint8Array(byteLength));
        chunksSent += 1;
        record.handedOutBytes += byteLength;
      },
      cancel() {
        record.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, record };
}

// Emits one chunk per pull without end. The hang threshold is derived from the
// limit the test runs at, not picked independently: a correct reader cancels
// having pulled at most the limit plus one chunk, so limit + two chunks is one
// chunk past the widest correct read — any reader still pulling there is
// draining past the limit, and pull returns a promise that never resolves so
// the test hangs rather than passes.
function neverEndingStream(limitBytes: number, chunkByteLength: number): {
  stream: ReadableStream<Uint8Array>;
  record: { handedOutBytes: number; cancelled: boolean };
} {
  const HANG_AFTER_BYTES = limitBytes + 2 * chunkByteLength;
  let handedOutBytes = 0;
  const record = { handedOutBytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(chunkByteLength));
        handedOutBytes += chunkByteLength;
        record.handedOutBytes = handedOutBytes;
        if (handedOutBytes >= HANG_AFTER_BYTES) {
          return new Promise(() => {});
        }
      },
      cancel() {
        record.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, record };
}

describe("readBodyWithinLimit", () => {
  // The refusal must not wait for the stream to end: a source that would
  // never end must be cut off at the limit, having pulled at most the limit
  // plus one chunk — the reader's proof that an oversized body is never fully
  // buffered.
  it("refuses a never-ending stream once the body crosses the limit, cancelling without draining", async () => {
    const CHUNK_BYTES = 4; // 3 chunks = 12 > 10: the crossing lands mid-stream
    const { stream, record } = neverEndingStream(LIMIT_BYTES, CHUNK_BYTES);
    const result = await readBodyWithinLimit(streamRequest(stream), LIMIT_BYTES);
    expect(result).toBeNull();
    expect(record.cancelled).toBe(true);
    expect(record.handedOutBytes).toBeLessThanOrEqual(LIMIT_BYTES + CHUNK_BYTES);
  });

  it("accepts a body of exactly the limit and returns its bytes", async () => {
    const body = "0123456789"; // exactly LIMIT_BYTES
    const result = await readBodyWithinLimit(
      new Request("https://overflow.test/upload", { method: "POST", body }),
      LIMIT_BYTES,
    );
    expect(result).toStrictEqual(Buffer.from(body, "utf8"));
  });

  it("refuses a body one byte past the limit, cancelling the source", async () => {
    // Two chunks totalling limit + 1: the first is retained, the second
    // crosses, and the reader must cancel rather than keep reading.
    const { stream, record } = trackedStream([6, 5]);
    const result = await readBodyWithinLimit(streamRequest(stream), LIMIT_BYTES);
    expect(result).toBeNull();
    expect(record.cancelled).toBe(true);
  });

  // The declared size is answered before the stream is touched, so an honest
  // oversize declaration costs zero reads; the handedOutBytes assertion is
  // what distinguishes this from a null produced after pulling.
  it("answers null without reading when Content-Length declares more than the limit", async () => {
    const { stream, record } = trackedStream([1]);
    const result = await readBodyWithinLimit(
      streamRequest(stream, { "content-length": String(LIMIT_BYTES + 1) }),
      LIMIT_BYTES,
    );
    expect(result).toBeNull();
    expect(record.handedOutBytes).toBe(0);
  });

  // Strict-greater is the declared-size pre-check's whole semantics, so the
  // boundary itself is pinned in the module's own suite: a declaration of
  // exactly the limit passes the pre-check and the body is read in full. The
  // route suites carry a 25 MiB case for this (tests/api/webhook.test.ts,
  // tests/api/webhook-gitlab.test.ts); this is where the pre-check's own
  // off-by-one mutant fails, rather than only where a route happens to.
  it("accepts a body whose Content-Length declares exactly the limit", async () => {
    const { stream, record } = trackedStream([LIMIT_BYTES]);
    const result = await readBodyWithinLimit(
      streamRequest(stream, { "content-length": String(LIMIT_BYTES) }),
      LIMIT_BYTES,
    );
    expect(result).toStrictEqual(Buffer.alloc(LIMIT_BYTES));
    expect(record.handedOutBytes).toBe(LIMIT_BYTES);
    expect(record.cancelled).toBe(false);
  });

  // A request with no body at all is the empty byte string, not an error.
  it("reads a null body as empty", async () => {
    const request = new Request("https://overflow.test/upload", { method: "POST" });
    expect(request.body).toBeNull();
    const result = await readBodyWithinLimit(request, LIMIT_BYTES);
    expect(result).toStrictEqual(Buffer.alloc(0));
  });

  it("concatenates a multi-chunk body under the limit and leaves the source uncancelled", async () => {
    const { stream, record } = trackedStream([4, 6]); // 10 bytes = the limit
    const result = await readBodyWithinLimit(streamRequest(stream), LIMIT_BYTES);
    expect(result).toStrictEqual(Buffer.alloc(LIMIT_BYTES));
    expect(record.cancelled).toBe(false);
  });
});
