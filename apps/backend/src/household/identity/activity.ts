import type { z } from "zod";
import type { identityObservationSchema } from "@home-agent/api/contracts";
import type { associateMembers } from "./association";

// Already accepted identity evidence; no pixels, features or inferred room location.
export function memberActivity(input: {
  id: string;
  firstObservedAt: number;
  deviceId: string;
  channel: number;
  deviceName: string;
  cameraRoomName: string | null;
  observation: z.infer<typeof identityObservationSchema>;
  association: ReturnType<typeof associateMembers>[number];
}) {
  const { association, observation } = input;
  const track = observation.tracks.find(
    (item) => item.trackId === association.trackId,
  );
  const evidence =
    track?.evidence.filter((item) => item.label === association.memberId) ?? [];
  if (!evidence.length || !observation.referenceVersions) return null;
  const camera = input.cameraRoomName
    ? `${input.cameraRoomName}的「${input.deviceName}」`
    : `「${input.deviceName}」`;
  return {
    memberId: association.memberId,
    memberKind: association.memberKind,
    record: {
      id: input.id,
      kind: "observation" as const,
      topic: "member_sighting",
      summary:
        association.state === "confirmed"
          ? `${camera}镜头 ${input.channel} 观察到${association.memberName}。`
          : `${camera}镜头 ${input.channel} 可能观察到${association.memberName}。`,
      certainty:
        association.state === "confirmed"
          ? ("supported" as const)
          : ("tentative" as const),
      occurredAt: new Date(association.observedAt),
      scopeEpoch: observation.run.scopeEpoch,
      data: {
        memberId: association.memberId,
        memberKind: association.memberKind,
        className: association.className,
        memberName: association.memberName,
        deviceId: input.deviceId,
        channel: input.channel,
        deviceName: input.deviceName,
        cameraRoomName: input.cameraRoomName,
        sourceRunId: association.sourceRunId,
        trackId: association.trackId,
        state: association.state,
        firstObservedAt: input.firstObservedAt,
        lastObservedAt: association.observedAt,
        timeBasis: "host_received_at",
        referenceVersions: observation.referenceVersions,
      },
      evidence,
    },
  };
}
