import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/lib/async/map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("preserves a legitimate undefined result and its input position", async () => {
    const result = await mapWithConcurrency([1], 4, async () => undefined);

    expect(result).toStrictEqual([undefined]);
  });

  it("starts no operations when reading the input length throws", async () => {
    const failure = new Error("length failed");
    const calls: number[] = [];
    const inputs = new Proxy([0, 1], {
      get(target, property, receiver) {
        if (property === "length") throw failure;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(mapWithConcurrency(inputs, 2, async (input) => {
      calls.push(input);
      return input;
    })).rejects.toBe(failure);
    expect(calls).toEqual([]);
  });

  it("does not read the input length after operations start", async () => {
    const failure = new Error("length read during an operation");
    const record: string[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const inputs = new Proxy([0, 1], {
      get(target, property, receiver) {
        if (property === "length" && record.length > 0) throw failure;
        return Reflect.get(target, property, receiver);
      },
    });
    const outcome = mapWithConcurrency(inputs, 2, async (input) => {
      record.push(`start ${input}`);
      await gates[input].promise;
      record.push(`settle ${input}`);
      return input * 2;
    }).then((values) => ({ values }), (error: unknown) => ({ error }));

    try {
      expect([...record]).toEqual(["start 0", "start 1"]);
      for (const gate of gates) gate.resolve();
      expect(await outcome).toEqual({ values: [0, 2] });
      expect(record).toEqual(["start 0", "start 1", "settle 0", "settle 1"]);
    } finally {
      for (const gate of gates) gate.resolve();
      await outcome;
    }
  });

  it("stops starting queued calls after a rejection", async () => {
    const ongoing = deferred<number>();
    const failing = deferred<number>();
    const calls: number[] = [];
    const first = new Error("first failure");
    const result = mapWithConcurrency([0, 1, 2], 2, (index) => {
      calls.push(index);
      return index === 0 ? ongoing.promise : index === 1 ? failing.promise : Promise.resolve(index);
    });
    const failure = expect(result).rejects.toBe(first);
    failing.reject(first);
    await failing.promise.catch(() => {});

    ongoing.resolve(0);
    await failure;
    expect(calls).toEqual([0, 1]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid concurrency cap %s",
    async (concurrency) => {
      await expect(mapWithConcurrency([1], concurrency, async (value) => value)).rejects.toThrow(RangeError);
    },
  );

  it("never exceeds the cap while processing more inputs than the cap", async () => {
    const inputs = Array.from({ length: 12 }, (_, index) => index);
    const gates = inputs.map(() => deferred<void>());
    const started = inputs.map(() => deferred<void>());
    let active = 0;
    let highWaterMark = 0;
    const result = mapWithConcurrency(inputs, 4, async (index) => {
      active += 1;
      highWaterMark = Math.max(highWaterMark, active);
      started[index].resolve();
      await gates[index].promise;
      active -= 1;
      return index * 2;
    });

    for (const index of inputs) {
      await started[index].promise;
      gates[index].resolve();
    }

    await expect(result).resolves.toEqual(inputs.map((index) => index * 2));
    expect(active).toBe(0);
    expect(highWaterMark).toBeLessThanOrEqual(4);
  });

  it("preserves input order when refilled workers complete out of order", async () => {
    const inputs = [0, 1, 2, 3, 4];
    const gates = inputs.map(() => deferred<void>());
    const started = inputs.map(() => deferred<void>());
    const finished = inputs.map(() => deferred<void>());
    const completionOrder: number[] = [];
    const result = mapWithConcurrency(inputs, 2, async (index) => {
      started[index].resolve();
      await gates[index].promise;
      completionOrder.push(index);
      finished[index].resolve();
      return index * 10;
    });

    for (const index of [1, 0, 3, 4, 2]) {
      await started[index].promise;
      gates[index].resolve();
      await finished[index].promise;
    }

    expect(completionOrder).toEqual([1, 0, 3, 4, 2]);
    await expect(result).resolves.toEqual([0, 10, 20, 30, 40]);
  });

  it("returns results in input order regardless of completion order", async () => {
    const gates = Array.from({ length: 3 }, () => deferred<string>());
    const finished = Array.from({ length: 3 }, () => deferred<void>());
    const completionOrder: number[] = [];
    const result = mapWithConcurrency([0, 1, 2], 3, async (index) => {
      const value = await gates[index].promise;
      completionOrder.push(index);
      finished[index].resolve();
      return value;
    });

    gates[2].resolve("third");
    await finished[2].promise;
    gates[0].resolve("first");
    await finished[0].promise;
    gates[1].resolve("second");
    await finished[1].promise;

    expect(completionOrder).toEqual([2, 0, 1]);
    await expect(result).resolves.toEqual(["first", "second", "third"]);
  });

  it("waits for every in-flight operation before rejecting", async () => {
    const first = new Error("first failure");
    const gates = Array.from({ length: 3 }, () => deferred<string>());
    const record: string[] = [];
    const result = mapWithConcurrency([0, 1, 2, 3], 3, async (index) => {
      record.push(`start ${index}`);
      try {
        return await gates[index].promise;
      } finally {
        record.push(`settle ${index}`);
      }
    });
    const outcome = result.then(
      () => { record.push("resolved"); },
      (error: unknown) => { record.push("rejected"); return error; },
    );

    gates[1].reject(first);
    try {
      // An event-loop checkpoint drains promise reactions without a clock margin.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(record).toEqual(["start 0", "start 1", "start 2", "settle 1"]);
      gates[2].resolve("second");
      gates[0].resolve("last");
      expect(await outcome).toBe(first);
      expect(record).toEqual([
        "start 0", "start 1", "start 2", "settle 1", "settle 2", "settle 0", "rejected",
      ]);
    } finally {
      gates[2].resolve("finished second");
      gates[0].resolve("finished last");
      await outcome;
    }
  });

  it.each([new Error("first failure"), undefined, null, false])(
    "preserves the chronologically first rejection reason %s after draining",
    async (first) => {
      const later = new Error("later failure");
      const gates = Array.from({ length: 2 }, () => deferred<string>());
      const record: number[] = [];
      const result = mapWithConcurrency([0, 1], 2, async (index) => {
        try {
          return await gates[index].promise;
        } finally {
          record.push(index);
        }
      });
      const outcome = result.then(
        () => ({ resolved: true }),
        (error: unknown) => ({ error, settled: [...record] }),
      );

      gates[1].reject(first);
      await new Promise<void>((resolve) => setImmediate(resolve));
      gates[0].reject(later);

      expect(await outcome).toEqual({ error: first, settled: [1, 0] });
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
