import { householdStreamPolicy } from "@home-agent/api/household";

export const householdLimits = {
  transactionMs: 5_000,
  metadataBytes: 2 * 1024 * 1024,
  directoryBytes: 4 * 1024 * 1024,
  snapshotBytes: householdStreamPolicy.snapshotBytes,
  changesBytes: 2 * 1024 * 1024,
  queuedChanges: 256,
  connections: 16,
  heartbeatMs: householdStreamPolicy.heartbeatMs,
  writeTimeoutMs: 15_000,
  specConcurrency: 3,
  specRetryMs: [2_000, 10_000],
} as const;
export const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value));
