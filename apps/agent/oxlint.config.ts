import { defineConfig } from "oxlint";
import base from "@home-agent/oxlint-config/base";

export default defineConfig({
  ...base,
  rules: {
    ...base.rules,
    "typescript/consistent-return": "off",
    "typescript/switch-exhaustiveness-check": "error",
  },
});
