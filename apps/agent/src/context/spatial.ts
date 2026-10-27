import type { z } from "zod";
import type {
  agentContextDataSchemas,
  agentObservationSchema,
} from "@home-agent/api/agent-context";

export function observationBinding(
  spatial: z.infer<typeof agentContextDataSchemas.spatial>,
  source: z.infer<typeof agentObservationSchema>["source"],
  observedAt: number,
) {
  const bindings = spatial.observation_bindings.filter(
    (binding) =>
      binding.enabled &&
      binding.device_id === source.deviceId &&
      binding.channel === source.channel,
  );
  if (bindings.length !== 1) return null;
  const binding = bindings[0]!;
  if (Date.parse(binding.updated_at) > observedAt) return null;
  return binding;
}

export function observationTarget(
  spatial: z.infer<typeof agentContextDataSchemas.spatial>,
  source: z.infer<typeof agentObservationSchema>["source"],
  observedAt: number,
) {
  const binding = observationBinding(spatial, source, observedAt);
  if (!binding) return null;

  return (
    (binding.space_id
      ? spatial.spaces.find((space) => space.id === binding.space_id)
      : spatial.passages.find(
          (passage) => passage.id === binding.passage_id,
        )) ?? null
  );
}
