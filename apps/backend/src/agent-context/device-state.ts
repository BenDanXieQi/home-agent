import type { z } from "zod";
import type { Projection } from "@home-agent/api/household";
import { agentDevicePropertySchema } from "@home-agent/api/agent-context";

/** Validate each new dynamic record once; preserve unchanged records by source identity. */
export function createAgentDeviceStateProjection() {
  const properties = new WeakMap<
    Projection["latest"][string],
    z.infer<typeof agentDevicePropertySchema>
  >();
  let previous: Projection["latest"] | undefined;
  let latest: Record<string, z.infer<typeof agentDevicePropertySchema>> = {};
  return (projection: Projection) => {
    if (previous !== projection.latest) {
      latest = Object.fromEntries(
        Object.entries(projection.latest).map(([key, fact]) => {
          let value = properties.get(fact);
          if (!value) {
            value = agentDevicePropertySchema.parse(fact);
            properties.set(fact, value);
          }
          return [key, value];
        }),
      );
      previous = projection.latest;
    }
    return {
      latest,
      source_health: projection.source_health,
      device_coverage: projection.device_coverage,
      collection: projection.collection,
      online: Object.values(projection.device)
        .filter((device) => !device.archived)
        .map(({ account_id, device_id, online }) => ({
          account_id,
          device_id,
          online,
        })),
    };
  };
}
