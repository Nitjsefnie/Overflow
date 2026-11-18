import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

it("records exactly the accepted advisory ids, scoped to the audited picomatch", async () => {
  const [pkg, lock] = await Promise.all(["package.json", "pnpm-lock.yaml"].map((file) => readFile(resolve(root, file), "utf8")));
  expect([JSON.parse(pkg).pnpm?.auditConfig?.ignoreGhsas, new Set(lock.match(/picomatch@\d+\.\d+\.\d+/g))]).toStrictEqual([["GHSA-fc5q-39xc-vjpf"], new Set(["picomatch@4.0.7"])]);
});
