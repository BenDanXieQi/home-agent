import { availableParallelism } from "node:os";
import { z } from "zod";

// Capture the host once per application process, including retries after failed initialization.
const startupAvailableCpus = availableParallelism();

export const cpuRatioSchema = z.number().positive().max(1).default(0.5);
// Per-worker native concurrency stays fixed; CPU share controls worker count.
export const detectionComputeBudget = {
  processes: 1,
  pendingTasks: 1,
  tasksPerWorker: 1,
  sharpThreads: 1,
  ortIntraOpThreads: 1,
} as const;
export const computeBudgetSchema = z
  .object({
    availableCpus: z.int().positive(),
    cpuRatio: cpuRatioSchema,
    workersPerProcess: z.int().positive(),
  })
  .refine(
    (budget) =>
      budget.workersPerProcess <=
      Math.max(1, Math.floor(budget.availableCpus * budget.cpuRatio)),
    "Worker count must not exceed the startup CPU budget",
  );

export function resolveComputeBudget(
  cpuRatio = cpuRatioSchema.parse(undefined),
  availableCpus = startupAvailableCpus,
) {
  return Object.freeze(
    computeBudgetSchema.parse({
      availableCpus,
      cpuRatio,
      workersPerProcess: Math.max(1, Math.floor(availableCpus * cpuRatio)),
    }),
  );
}
