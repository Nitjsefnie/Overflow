import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (file: string): Promise<string> => readFile(resolve(root, file), "utf8");

it("accepts no advisory, in package.json or in the workspace file", async () => {
  const [pkg, workspace] = await Promise.all(["package.json", "pnpm-workspace.yaml"].map(read));
  expect([JSON.parse(pkg).pnpm, workspace.match(/auditConfig|GHSA-/g)]).toStrictEqual([{ auditConfig: { ignoreGhsas: [] } }, null]);
});

it("pins allowBuilds false for every ignored install script", async () => {
  const workspace = await read("pnpm-workspace.yaml");
  for (const name of ["cpu-features", "protobufjs", "ssh2"]) {
    expect(workspace, name).toMatch(new RegExp(`^  ${name}: false$`, "m"));
  }
});
