import { z } from "zod";
import { memberActivityDataSchema } from "../contracts/perception";
import type { agentObservationSchema } from "../contracts/agent-context";
import type { projectWindowObservation } from "./window-observations";

/** Sighting association fields and attribution revisions cross the storage boundary. */
export const memberObservationSchema = z.object({
  id: z.uuid(),
  data: memberActivityDataSchema.pick({
    sourceRunId: true,
    run: true,
    mediaGeneration: true,
    trackId: true,
    deviceId: true,
    channel: true,
    firstObservedAt: true,
    lastObservedAt: true,
  }),
  known: z.boolean(),
  revision: memberActivityDataSchema.shape.attribution.shape.revision,
});

/** Windows own scene and sound clues; member records are shared references, never speakers. */
export function assembleAgentObservations(
  sightings: z.infer<typeof memberObservationSchema>[],
  windows: ReturnType<typeof projectWindowObservation>[],
) {
  const records: z.infer<typeof agentObservationSchema>[] = [];
  const matched = new Set<string>();
  const byTrack = Map.groupBy(sightings, ({ data }) =>
    JSON.stringify([
      data.sourceRunId,
      data.run.scopeEpoch,
      data.deviceId,
      data.channel,
      data.mediaGeneration,
      data.trackId,
    ]),
  );
  for (const window of windows) {
    const references = new Map<string, (typeof sightings)[number]>();
    let unidentified = false;
    for (const frame of window.frames) {
      unidentified ||= frame.untrackedTarget;
      for (const trackId of frame.trackIds) {
        let known = false;
        const candidates =
          byTrack.get(
            JSON.stringify([
              window.videoRun?.runId,
              window.run.scopeEpoch,
              window.run.deviceId,
              window.run.channel,
              frame.generation,
              trackId,
            ]),
          ) ?? [];
        for (const sighting of candidates) {
          if (
            frame.receivedAt < sighting.data.firstObservedAt ||
            frame.receivedAt > sighting.data.lastObservedAt
          )
            continue;
          references.set(sighting.id, sighting);
          matched.add(sighting.id);
          known ||= sighting.known;
        }
        if (!known) unidentified = true;
      }
    }
    const associated = [...references.values()];
    const reasons: z.infer<typeof agentObservationSchema>["reasons"] = [];
    if (associated.length) reasons.push("member_sighting");
    if (unidentified) reasons.push("unidentified_target");
    if (window.visualChanged) reasons.push("visual_change");
    if (window.speech) reasons.push("speech");
    if (window.petSound) reasons.push("pet_sound");
    if (!reasons.length) continue;
    records.push({
      id: window.id,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      reasons,
      member_sighting_ids: associated.map((record) => record.id),
      member_sighting_revisions: Object.fromEntries(
        associated.map((record) => [record.id, record.revision]),
      ),
      window_id: window.id,
      window_material: window.material,
    });
  }
  for (const sighting of sightings) {
    if (matched.has(sighting.id)) continue;
    records.push({
      id: sighting.id,
      startedAt: sighting.data.firstObservedAt,
      endedAt: sighting.data.lastObservedAt,
      reasons: !sighting.known
        ? ["member_sighting", "unidentified_target"]
        : ["member_sighting"],
      member_sighting_ids: [sighting.id],
      member_sighting_revisions: { [sighting.id]: sighting.revision },
      window_id: null,
      window_material: null,
    });
  }
  return {
    records: records.toSorted(
      (a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id),
    ),
  };
}
