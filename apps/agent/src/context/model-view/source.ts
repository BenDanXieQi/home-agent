import { z } from "zod";
import type { agentReceivedContextSchema } from "@home-agent/api/agent-receipts";
import type { agentContextDataSchemas } from "@home-agent/api/agent-context";
import type { deviceCapabilitySchema } from "@home-agent/api/devices";

export type ReceivedContext = z.infer<typeof agentReceivedContextSchema>;
export type Household = z.infer<typeof agentContextDataSchemas.household>;
export type Capability = z.infer<typeof deviceCapabilitySchema>;
export type Specification = Household["specs"][string];
export const attentionSchema = z.record(z.string(), z.array(z.string()));

export function requireReadyContext(snapshot: ReceivedContext) {
  const { household, device_state, members, spatial, observations } =
    snapshot.parts;
  if (
    !snapshot.scope ||
    household?.status !== "ready" ||
    device_state?.status !== "ready" ||
    members?.status !== "ready" ||
    spatial?.status !== "ready" ||
    observations?.status !== "ready"
  ) {
    throw new Error(
      "Model context requires a household scope and all five ready parts",
    );
  }
  return {
    scope: snapshot.scope,
    household: household.data,
    state: device_state.data,
    members: members.data.members,
    receivedAt: snapshot.received_at,
  };
}

/** Lexical ordering independent of the host locale. */
export function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
