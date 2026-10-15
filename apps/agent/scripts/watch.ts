import { generateModules } from "./codegen";
import { watchModules } from "./codegen/modules";

export async function watchAgentModules() {
  await generateModules();
  return watchModules(
    [
      new URL("../src/workflows/", import.meta.url),
      new URL("../src/routes/", import.meta.url),
    ],
    generateModules,
  );
}
