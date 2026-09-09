// `tests/**/*.tsx` is what puts the component suites under tests/components/
// under the compiler. Vitest transpiles without type-checking, so nothing else
// holds them to the contract: with the glob absent from `include`, a component
// test can assert against a prop shape, a mock signature or a return type that
// no longer exists and every check stays green.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("tsconfig.json include", () => {
  it("type-checks the component test files", () => {
    const tsconfig = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)), "utf8"),
    ) as { include?: unknown };

    expect(Array.isArray(tsconfig.include), "tsconfig.json include must be an array").toBe(true);

    expect(
      tsconfig.include,
      'tsconfig.json include must contain "tests/**/*.tsx": without it the component suites under ' +
        "tests/components/ are invisible to tsc, so pnpm typecheck and pnpm build never see them",
    ).toContain("tests/**/*.tsx");
  });
});
