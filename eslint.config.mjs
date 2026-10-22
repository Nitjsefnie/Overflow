import { defineConfig, globalIgnores } from "eslint/config";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextTypeScript,
  {
    files: ["tests/**"],
    ignores: ["tests/support/owned-temp-directory.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name=/^mkdtemp(Sync)?$/], MemberExpression[computed=true][property.value=/^mkdtemp(Sync)?$/], Property[key.value=/^mkdtemp(Sync)?$/], :matches(MemberExpression[computed=true] > TemplateLiteral.property, Property[computed=true] > TemplateLiteral.key)[expressions.length=0] > TemplateElement[value.cooked=/^mkdtemp(Sync)?$/]",
          message: "Use tests/support/owned-temp-directory and dispose the directory in its existing test lifecycle.",
        },
      ],
    },
  },
  globalIgnores([".next/**", ".next-release-*/**", "coverage/**", "node_modules/**"]),
]);
