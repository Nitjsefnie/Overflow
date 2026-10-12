import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("Next runtime setup", () => {
  it("initializes native request storage before Next captures its global constructor", async () => {
    // Use Next's external CommonJS graph, just as next/server does. A Vitest
    // module reset cannot repair a constructor captured in that graph.
    const { createAsyncLocalStorage } = require(
      "next/dist/server/app-render/async-local-storage",
    ) as typeof import("next/dist/server/app-render/async-local-storage");
    const storage = createAsyncLocalStorage<{ requestId: string }>();

    await storage.run({ requestId: "outer" }, async () => {
      await Promise.resolve();
      expect(storage.getStore()).toEqual({ requestId: "outer" });
      storage.run({ requestId: "inner" }, () => {
        expect(storage.getStore()).toEqual({ requestId: "inner" });
      });
      expect(storage.getStore()).toEqual({ requestId: "outer" });
    });

    expect(storage.getStore()).toBeUndefined();
    expect(storage).toBeInstanceOf(AsyncLocalStorage);
    expect(Reflect.get(globalThis, "AsyncLocalStorage")).toBe(AsyncLocalStorage);
  });
});
