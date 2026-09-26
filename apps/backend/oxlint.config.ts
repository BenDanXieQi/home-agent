import { defineConfig } from "oxlint";
import base from "@home-agent/oxlint-config/base";

export default defineConfig({
  ...base,
  overrides: [
    ...(base.overrides ?? []),
    {
      files: ["tests/**/*.test.ts"],
      // Bun's async expect matchers are declared void but must be awaited at runtime.
      rules: { "typescript/await-thenable": "off" },
    },
  ],
});
