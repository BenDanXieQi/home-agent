import { generateRoutes } from "./routes";
import { generateWorkflows } from "./workflows";

export async function generateModules() {
  await generateWorkflows();
  await generateRoutes();
}

if (import.meta.main) await generateModules();
