import type {
  deviceControlResultSchema,
  commandTargetSchema,
} from "@home-agent/api/action-provenance";

/** Adapters own protocol dispatch; send start is independent of response validation. */
export type DeviceControl = {
  dispatch: (
    target: ReturnType<typeof commandTargetSchema.parse>,
    signal: AbortSignal,
    assertCurrent: () => void,
    onSendStarted: (at: string) => void,
  ) => Promise<ReturnType<typeof deviceControlResultSchema.parse>>;
};
