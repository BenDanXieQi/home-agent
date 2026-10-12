import type {
  commandRecordSchema,
  commandTargetSchema,
} from "@home-agent/api/action-provenance";

type Command = ReturnType<typeof commandRecordSchema.parse>;
type Target = ReturnType<typeof commandTargetSchema.parse>;
/** The household owns command records; adapters own protocol dispatch and failures. */
export type DeviceControl = {
  endpoint: (target: Target) => string;
  dispatch: (
    target: Target,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) => Promise<
    Pick<
      Command,
      | "sent_at"
      | "received_at"
      | "outcome"
      | "response_matches"
      | "completeness"
      | "provider_code"
      | "message"
      | "output"
      | "response"
      | "error"
    >
  >;
  failure: (error: unknown) => Command["error"];
};
