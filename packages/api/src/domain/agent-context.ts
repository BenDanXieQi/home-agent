import type { z } from "zod";
import type { agentContextSnapshotSchema } from "../contracts/agent-context";
import type { agentContextPublicationSchema } from "../contracts/agent-context";
import { produce, freeze } from "../immutable";

/** Device deltas require a ready baseline in the same scope. */
export function mergeAgentContextSnapshot(
  previous: z.infer<typeof agentContextSnapshotSchema> | null,
  next: z.infer<typeof agentContextPublicationSchema>,
) {
  const sameScope =
    previous?.scope?.account_id === next.scope?.account_id &&
    previous?.scope?.home_id === next.scope?.home_id &&
    previous?.scope?.scope_epoch === next.scope?.scope_epoch;
  const { device_state: deviceState, ...otherParts } = next.parts;
  const parts: z.infer<typeof agentContextSnapshotSchema>["parts"] = {
    ...(sameScope ? previous?.parts : {}),
    ...otherParts,
  };
  if (deviceState?.status === "delta") {
    const baseline = parts.device_state;
    if (baseline?.status !== "ready")
      throw new Error("Device delta requires a current ready snapshot");
    parts.device_state = freeze(
      produce(baseline, (draft) => {
        draft.read_at = deviceState.read_at;
        for (const change of deviceState.data.changes) {
          const records: Record<string, unknown> = draft.data[change.entity];
          if (change.op === "remove") delete records[change.key];
          else records[change.key] = change.value;
        }
        if (deviceState.data.online !== undefined)
          draft.data.online = deviceState.data.online;
      }),
    );
  } else if (deviceState) parts.device_state = deviceState;
  return freeze({
    scope: next.scope,
    parts,
  });
}
