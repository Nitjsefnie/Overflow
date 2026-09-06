import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const sourceRoot = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(`${specifier.slice(2)}${suffix}`, sourceRoot);
        if (existsSync(candidate)) {
          return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
