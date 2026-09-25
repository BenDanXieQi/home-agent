import { defineConfig } from "oxlint";
import base from "./base.ts";

export default defineConfig({
  extends: [base],
  plugins: ["react", "typescript", "unicorn", "oxc", "jsx-a11y"],
  env: {
    browser: true,
  },
  rules: {
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "error",
    "react/only-export-components": [
      "error",
      {
        allowConstantExport: true,
      },
    ],
    "react/react-in-jsx-scope": "off",
  },
});
