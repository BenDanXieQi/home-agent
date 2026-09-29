import { fileURLToPath } from "node:url";
import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  jsPlugins: [
    {
      name: "turbo",
      specifier: fileURLToPath(import.meta.resolve("eslint-plugin-turbo")),
    },
  ],
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  rules: {
    "no-void": "error",
    "typescript/no-floating-promises": ["error", { ignoreVoid: false }],
    "turbo/no-undeclared-env-vars": "error",
  },
  env: {
    bun: true,
    node: true,
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/.turbo/**",
    "**/dist/**",
    "**/coverage/**",
  ],
});
