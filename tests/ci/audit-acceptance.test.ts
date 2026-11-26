import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

it("records exactly the accepted advisory ids, scoped to the audited picomatch", async () => {
  const [workspace, lock] = await Promise.all(["pnpm-workspace.yaml", "pnpm-lock.yaml"].map((file) => readFile(resolve(root, file), "utf8")));
  const ids = [...workspace.matchAll(/^    - (GHSA-[\w-]+)$/gm)].map((match) => match[1]);
  expect([ids, new Set(lock.match(/picomatch@\d+\.\d+\.\d+/g))]).toStrictEqual([["GHSA-fc5q-39xc-vjpf"], new Set(["picomatch@4.0.7"])]);
});

/** Why each `pnpm.auditConfig.ignoreGhsas` id is accepted: the recorded disposition advisory-tracking.yml's listing stops naming it for. */
const REASONS: Record<string, string> = {
  "GHSA-fc5q-39xc-vjpf": "unpatched (4.0.7 is picomatch's newest release), and every copy is reached only through the dev-only vite, vitest and tinyglobby",
};

it("records exactly one non-blank reason per accepted advisory id", async () => {
  const ids = [...(await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8")).matchAll(/^    - (GHSA-[\w-]+)$/gm)].map((match) => match[1]);
  expect([[...ids].sort(), Object.values(REASONS).filter((reason) => reason.trim() === "")]).toStrictEqual([Object.keys(REASONS).sort(), []]);
});
