import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  agentDeviceChangeSchema,
  type agentContextPublicationSchema,
  type agentContextSnapshotSchema,
} from "@home-agent/api/agent-context";

/** Compare against this connection's last completed delivery, including skipped commits. */
export function prepareAgentContextDelivery(
  previous: z.infer<typeof agentContextSnapshotSchema> | undefined,
  next: z.infer<typeof agentContextSnapshotSchema>,
  fullBytes: number,
) {
  const baseline = previous?.parts.device_state;
  const current = next.parts.device_state;
  if (
    !isDeepStrictEqual(previous?.scope, next.scope) ||
    baseline?.status !== "ready" ||
    current?.status !== "ready"
  )
    return undefined;

  const changes: z.infer<typeof agentDeviceChangeSchema>[] = [];
  for (const entity of [
    "latest",
    "source_health",
    "device_coverage",
    "collection",
  ] as const) {
    const before = baseline.data[entity];
    const after = current.data[entity];
    if (before === after) continue;
    // Collection is a singleton and can only be replaced, never removed.
    if (entity !== "collection") {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key))
          changes.push(
            agentDeviceChangeSchema.parse({ op: "remove", entity, key }),
          );
      }
    }
    for (const [key, value] of Object.entries(after)) {
      const oldRecords: Record<string, unknown> = before;
      if (!isDeepStrictEqual(oldRecords[key], value))
        changes.push(
          agentDeviceChangeSchema.parse({ op: "upsert", entity, key, value }),
        );
    }
  }
  const online = isDeepStrictEqual(baseline.data.online, current.data.online)
    ? undefined
    : current.data.online;
  const delta = {
    ...next,
    parts: {
      ...next.parts,
      device_state: {
        status: "delta" as const,
        read_at: current.read_at,
        truncated: false as const,
        data: { changes, ...(online === undefined ? {} : { online }) },
      },
    },
  } satisfies z.infer<typeof agentContextPublicationSchema>;
  // A widespread change can be cheaper to send as a complete part.
  const data = JSON.stringify(delta);
  return Buffer.byteLength(data) < fullBytes ? data : undefined;
}
