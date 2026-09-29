// One owner for the image and inference concurrency budget.
// sharpThreads limits libvips threads per image, not all process threads.
export const detectionComputeBudget = {
  processes: 1,
  pendingTasks: 1,
  workersPerProcess: 1,
  tasksPerWorker: 1,
  sharpThreads: 1,
  ortIntraOpThreads: 1,
} as const;
