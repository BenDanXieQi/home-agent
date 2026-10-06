import { z } from "zod";
import { memberActivityDataSchema } from "../contracts/perception";
import {
  agentSightingAttributionSchema,
  agentSightingSummarySchema,
  type agentObservationSchema,
} from "../contracts/agent-context";
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
  attribution: agentSightingAttributionSchema,
  revision: memberActivityDataSchema.shape.attribution.shape.revision,
});

export function sightingStateKey(
  record: z.infer<typeof memberObservationSchema>,
) {
  return record.attribution.kind === "known"
    ? JSON.stringify(["member", record.attribution.association.memberId])
    : JSON.stringify(["unknown", record.data.deviceId, record.data.channel]);
}

/** Equal-time alternatives remain visible instead of inventing a single location. */
export function latestMemberObservations(
  records: z.infer<typeof memberObservationSchema>[],
) {
  return [...Map.groupBy(records, sightingStateKey).values()].flatMap(
    (group) => {
      const latest = group.reduce(
        (at, record) => Math.max(at, record.data.lastObservedAt),
        -Infinity,
      );
      return group.filter((record) => record.data.lastObservedAt === latest);
    },
  );
}

/** Windows own scene and sound clues; member records are shared references, never speakers. */
export function assembleAgentObservations(
  sightings: z.infer<typeof memberObservationSchema>[],
  windows: ReturnType<typeof projectWindowObservation>[],
) {
  const latestSightings = latestMemberObservations(sightings);
  const latestIds = new Set(latestSightings.map((record) => record.id));
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
          known ||= sighting.attribution.kind === "known";
        }
        if (!known) unidentified = true;
      }
    }
    const associated = [...references.values()].filter((record) =>
      latestIds.has(record.id),
    );
    const reasons: z.infer<typeof agentObservationSchema>["reasons"] = [];
    if (associated.length) reasons.push("member_sighting");
    if (unidentified) reasons.push("unidentified_target");
    if (window.visualChanged) reasons.push("visual_change");
    if (window.speech) reasons.push("speech");
    if (window.petSound) reasons.push("pet_sound");
    if (!reasons.length) continue;
    records.push({
      id: window.id,
      source: { deviceId: window.run.deviceId, channel: window.run.channel },
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
    if (!latestIds.has(sighting.id)) continue;
    if (matched.has(sighting.id)) continue;
    records.push({
      id: sighting.id,
      source: {
        deviceId: sighting.data.deviceId,
        channel: sighting.data.channel,
      },
      startedAt: sighting.data.firstObservedAt,
      endedAt: sighting.data.lastObservedAt,
      reasons:
        sighting.attribution.kind === "unknown"
          ? ["member_sighting", "unidentified_target"]
          : ["member_sighting"],
      member_sighting_ids: [sighting.id],
      member_sighting_revisions: { [sighting.id]: sighting.revision },
      window_id: null,
      window_material: null,
    });
  }
  const ordered = records.toSorted(
    (a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id),
  );
  const seenClues = new Set<string>();
  const seenMembers = new Set<string>();
  const current = ordered.flatMap((record) => {
    const memberIds = record.member_sighting_ids.filter(
      (id) => !seenMembers.has(id),
    );
    const reasons = record.reasons.filter((reason) => {
      if (reason === "member_sighting") return memberIds.length > 0;
      const key = JSON.stringify([
        record.source.deviceId,
        record.source.channel,
        reason,
      ]);
      if (seenClues.has(key)) return false;
      seenClues.add(key);
      return true;
    });
    if (!reasons.length) return [];
    for (const id of memberIds) seenMembers.add(id);
    return [
      {
        ...record,
        reasons,
        member_sighting_ids: memberIds,
        member_sighting_revisions: Object.fromEntries(
          memberIds.map((id) => [id, record.member_sighting_revisions[id]!]),
        ),
      },
    ];
  });
  return {
    member_sightings: latestSightings
      .map(({ id, data, revision, attribution }) =>
        agentSightingSummarySchema.parse({
          ...data,
          id,
          revision,
          attribution,
          timeBasis: "host_received_at",
        }),
      )
      .toSorted(
        (a, b) =>
          b.lastObservedAt - a.lastObservedAt || a.id.localeCompare(b.id),
      ),
    records: current,
  };
}
