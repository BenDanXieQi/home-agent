import { defineConfig } from "oxlint";
import base from "@home-agent/oxlint-config/base";

export default defineConfig({
  ...base,
  overrides: [
    ...(base.overrides ?? []),
    {
      files: ["tests/**/*.test.ts"],
      rules: { "typescript/await-thenable": "off" },
    },
  ],
});
