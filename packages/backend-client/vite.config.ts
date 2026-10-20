import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: "index",
    },
    rolldownOptions: {
      external: [
        "zod",
        "hono/client",
        ...builtinModules,
        /^node:/,
        /^@earendil-works\//,
        "@home-agent/observability",
      ],
      treeshake: { moduleSideEffects: false },
    },
  },
});
