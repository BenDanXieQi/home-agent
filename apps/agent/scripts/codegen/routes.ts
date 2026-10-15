import { fileURLToPath } from "node:url";
import {
  scanModules,
  validateModuleNames,
  writeGeneratedFile,
} from "./modules";

const routeDirectory = fileURLToPath(
  new URL("../../src/routes/", import.meta.url),
);

export async function generateRoutes() {
  const files = scanModules(routeDirectory, "*/route.ts");
  const names = files.map((file) => file.slice(0, -"/route.ts".length));
  validateModuleNames(names);
  const source = `import { createRouteApp, type RouteContext } from "./definition";
${names.map((name, index) => `import { createRoutes as createRoutes${index} } from "./${name}/route";`).join("\n")}

export function createRegisteredRoutes(context: RouteContext) {
  return createRouteApp()
${names.map((_name, index) => `    .route("/api", createRoutes${index}(context))`).join("\n")};
}
`;
  await writeGeneratedFile(`${routeDirectory}registry.generated.ts`, source);
}

if (import.meta.main) await generateRoutes();
