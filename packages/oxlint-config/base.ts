import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  jsPlugins: ["eslint-plugin-turbo"],
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  rules: {
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
