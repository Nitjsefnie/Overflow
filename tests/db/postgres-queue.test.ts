import { describe, expect, it } from "vitest";
// The package exposes no subpath for its internals and ships no types for them, so the patched
// module is reached by path and its shape is declared here. `peek` is added by
// patches/postgres@3.4.9.patch and exists only for the pool's close path.
// @ts-expect-error -- untyped package internal
import QueueFactory from "../../node_modules/postgres/src/queue.js";

interface PatchedQueue<T> {
  readonly length: number;
  push(x: T): T;
  peek(): T | undefined;
  shift(): T | undefined;
  remove(x: T): T | null;
}

const Queue = QueueFactory as <T>(initial?: T[]) => PatchedQueue<T>;

/**
 * The pool's close path decides what to do with the head of `queries` by reading it without
 * taking it, so `peek` has to name the element the next `shift` returns — at every read position,
 * not only the first. The queue keeps a read index rather than splicing, so a `peek` written as
 * `xs[0]` agrees with `shift` exactly once and then returns a consumed slot; the close path would
 * dereference `undefined` and throw out of a socket close handler.
 */
describe("the patched client queue's peek", () => {
  it("names the element the next shift returns, at every read position", () => {
    const queue = Queue<{ id: string }>();
    const pushed = [queue.push({ id: "a" }), queue.push({ id: "b" }), queue.push({ id: "c" })];

    const record = pushed.map(() => ({ peeked: queue.peek(), shifted: queue.shift() }));

    expect(record).toEqual(pushed.map((item) => ({ peeked: item, shifted: item })));
  });

  it("names the head of a partly drained queue that was filled again", () => {
    const queue = Queue<{ id: string }>();
    queue.push({ id: "first" });
    const second = queue.push({ id: "second" });
    // A partial drain, so the read index stays nonzero and the consumed slot is blanked. A queue
    // drained empty resets the index to 0, which is why a refill on its own says nothing about
    // where `peek` reads from.
    queue.shift();

    const refilled = queue.push({ id: "third" });

    expect([
      { length: queue.length, peeked: queue.peek(), shifted: queue.shift() },
      { length: queue.length, peeked: queue.peek(), shifted: queue.shift() },
    ]).toEqual([
      { length: 2, peeked: second, shifted: second },
      { length: 1, peeked: refilled, shifted: refilled },
    ]);
  });

  it("names the head of a queue that was drained empty and filled again", () => {
    const queue = Queue<{ id: string }>();
    queue.push({ id: "only" });
    // Draining the last element takes the other branch of `shift`: instead of blanking the
    // consumed slot it resets the read index to 0 and replaces the backing array. A queue filled
    // after that has to be read from the front again, and the two halves of the reset have to
    // agree -- keeping either the old index or the old array leaves `peek` on a slot `shift` will
    // never return.
    queue.shift();

    const afterReset = queue.push({ id: "next" });

    expect({ length: queue.length, peeked: queue.peek(), shifted: queue.shift() }).toEqual({
      length: 1,
      peeked: afterReset,
      shifted: afterReset,
    });
  });
});
