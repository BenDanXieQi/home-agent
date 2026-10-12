import { recordPruneBatchSize } from "./retention";
import type { createMaterialRepository } from "../materials/repository";
import type { createCommandRepository } from "../operations/repository";

/** Household record retention runs independently of vendor collection. */
export function createRecordMaintenance(
  materials: Pick<ReturnType<typeof createMaterialRepository>, "pruneRecords">,
  commands: Pick<ReturnType<typeof createCommandRepository>, "pruneRecords">,
) {
  let pruning: Promise<void> | undefined;
  let closed = false;
  async function drain() {
    const pending = { materials: true, commands: true };
    while (pending.materials || pending.commands) {
      if (closed) return;
      const [material, command] = await Promise.allSettled([
        pending.materials ? materials.pruneRecords() : Promise.resolve(0),
        pending.commands ? commands.pruneRecords() : Promise.resolve(0),
      ]);
      if (material.status === "rejected" || command.status === "rejected")
        console.warn("Household record pruning failed");
      pending.materials =
        material.status === "fulfilled" &&
        material.value === recordPruneBatchSize;
      pending.commands =
        command.status === "fulfilled" &&
        command.value === recordPruneBatchSize;
    }
  }
  const timer = setInterval(() => {
    if (closed || pruning) return;
    pruning = drain().finally(() => {
      pruning = undefined;
    });
  }, 3600_000);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await pruning;
    },
  };
}
