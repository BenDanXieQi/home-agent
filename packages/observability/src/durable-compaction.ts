import {
  CompactionTask,
  defineTask,
  type RegistryReader,
} from "@earendil-works/pi-durable";
import { withDurableCompactionTrace } from "./durable";

/** Decorate the built-in summarization phase for the pinned Pi runtime. */
export function observeDurableRegistry(registry: RegistryReader) {
  const definition = CompactionTask.definition;
  const summarize = definition.phases.summarize;
  const compaction = defineTask({
    ...definition,
    phases: {
      ...definition.phases,
      summarize: (...args: Parameters<typeof summarize>) =>
        withDurableCompactionTrace(...args, () => summarize(...args)),
    },
  });
  return {
    snapshot() {
      const snapshot = registry.snapshot();
      return {
        installed: () => snapshot.installed(),
        extension: (name: string) => snapshot.extension(name),
        tools: () => snapshot.tools(),
        sections: () => snapshot.sections(),
        tasks: () =>
          snapshot
            .tasks()
            .map((task) =>
              task.definition.name === definition.name ? compaction : task,
            ),
        task: (name: string) =>
          name === definition.name ? compaction : snapshot.task(name),
      };
    },
    subscribe: (listener: Parameters<RegistryReader["subscribe"]>[0]) =>
      registry.subscribe(listener),
  } satisfies RegistryReader;
}
