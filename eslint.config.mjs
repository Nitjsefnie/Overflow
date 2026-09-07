import { defineConfig, globalIgnores } from "eslint/config";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextTypeScript,
  globalIgnores([".next/**", ".next-release-*/**", "coverage/**", "node_modules/**"]),
]);
