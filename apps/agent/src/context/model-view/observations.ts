import type { requireReadyContext } from "./source";
import { compareText } from "./source";
import { observationTarget } from "../spatial";

export function latestObservations(
  source: ReturnType<typeof requireReadyContext>,
) {
  const { observations, spatial } = source;
  const cameras = new Map(
    Object.values(source.household.device).map((device) => [
      device.device_id,
      device,
    ]),
  );
  const sightings =
    observations.sources.member_sightings.status === "ready"
      ? observations.member_sightings
      : [];
  const byMember = Map.groupBy(
    sightings.flatMap((sighting) =>
      sighting.attribution.kind === "known"
        ? [{ ...sighting, association: sighting.attribution.association }]
        : [],
    ),
    (sighting) => sighting.association.memberId,
  );
  function observationArea(sighting: (typeof sightings)[number]) {
    const target = observationTarget(
      spatial,
      sighting,
      sighting.firstObservedAt,
    );
    return target ? `${target.name}（观测区域）` : null;
  }
  const identityLabels = {
    candidate: "待确认",
    confirmed: "已确认",
    inferred: "推断",
  } as const;
  const clues = Map.groupBy(
    observations.records.toSorted(
      (a, b) => b.endedAt - a.endedAt || compareText(a.id, b.id),
    ),
    (record) => JSON.stringify(record.source),
  );
  return {
    as_of: observations.as_of,
    sources: {
      member_sightings: observations.sources.member_sightings.status,
      perception: observations.sources.perception.status,
    },
    members: source.members
      .toSorted((a, b) => compareText(a.id, b.id))
      .map((member) => {
        const records = byMember.get(member.id) ?? [];
        return {
          ...member,
          last_seen: records
            .toSorted((a, b) => compareText(a.id, b.id))
            .map((record) => {
              const camera = cameras.get(record.deviceId);
              const cameraSource = camera
                ? `${camera.alias || camera.name} [${record.deviceId}]`
                : record.deviceId;
              return {
                at: new Date(record.lastObservedAt).toISOString(),
                location:
                  observationArea(record) ??
                  `${cameraSource} / 镜头 ${record.channel}（摄像头来源，位置未确认）`,
                identity: identityLabels[record.association.state],
              };
            }),
        };
      }),
    clues: [...clues.values()]
      .map((records) => {
        const latest = records.flatMap((record) =>
          record.reasons
            .filter((reason) => reason !== "member_sighting")
            .map((kind) => ({
              kind,
              at: new Date(record.endedAt).toISOString(),
            })),
        );
        const { deviceId, channel } = records[0]!.source;
        const camera = cameras.get(deviceId);
        return {
          device_id: deviceId,
          name: camera ? camera.alias || camera.name : deviceId,
          channel,
          latest,
        };
      })
      .filter((camera) => camera.latest.length > 0),
  };
}
