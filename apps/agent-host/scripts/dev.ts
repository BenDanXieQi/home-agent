import { watchAgentModules } from "@home-agent/agent/development";

const watcher = await watchAgentModules();
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

watcher.close();
process.exit(process.exitCode ?? 0);
