import { defineConfig, globalIgnores } from "eslint/config";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "node_modules/**"]),
]);
