import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

it("records exactly the accepted advisory ids in pnpm's audit config", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  expect(pkg.pnpm?.auditConfig?.ignoreGhsas ?? []).toStrictEqual([]);
});
