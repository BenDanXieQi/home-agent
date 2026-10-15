import { generateModules } from "./codegen";
import { watchModules } from "./codegen/modules";

await generateModules();
const watcher = watchModules(
  [
    new URL("../src/workflows/", import.meta.url),
    new URL("../src/routes/", import.meta.url),
  ],
  generateModules,
);
process.once("SIGINT", () => {
  watcher.close();
});
process.once("SIGTERM", () => {
  watcher.close();
});
try {
  await import("../src/main");
} catch (error) {
  watcher.close();
  throw error;
}
