import type { z } from "zod";
import {
  memberActivityDataSchema,
  identityReferenceVersionsSchema,
} from "@home-agent/api/contracts";

/** Accepted attribution evidence only; no inferred room location, pixels or features. */
export function memberActivity(
  id: string,
  input: z.infer<typeof memberActivityDataSchema>,
) {
  const data = memberActivityDataSchema.parse(input);
  const current = data.attribution.current;
  const association = current.kind === "known" ? current.association : null;
  const camera = data.cameraRoomName
    ? `${data.cameraRoomName}的「${data.deviceName}」`
    : `「${data.deviceName}」`;
  const summary = association
    ? association.basis === "appearance"
      ? `${camera}镜头 ${data.channel} 推测观察到${association.memberName}（人体外观匹配）。`
      : `${camera}镜头 ${data.channel} ${association.state === "confirmed" ? "观察到" : "可能观察到"}${association.memberName}。`
    : `${camera}镜头 ${data.channel} 的轨迹 ${data.trackId} 成员归属已撤销。`;
  const evidence =
    current.kind === "unknown"
      ? [{ basis: current.reason, ...current.trigger }]
      : current.association.basis === "appearance"
        ? [
            {
              basis: "appearance",
              evidence: current.association.evidence,
              references: current.association.references,
              referenceIds: current.association.referenceIds,
              score: current.association.score,
              margin: current.association.margin,
              policyVersion: current.association.policyVersion,
            },
          ]
        : current.association.evidence.map((item) => ({
            basis: current.association.basis,
            ...item,
          }));
  return {
    record: {
      id,
      kind: "observation" as const,
      topic: "member_sighting",
      summary,
      certainty:
        association?.state === "confirmed"
          ? ("supported" as const)
          : ("tentative" as const),
      occurredAt: new Date(data.firstObservedAt),
      scopeEpoch: data.run.scopeEpoch,
      data,
      evidence,
    },
  };
}
export function activityReferenceIds(
  current: z.infer<typeof memberActivityDataSchema>["attribution"]["current"],
) {
  return current.kind === "known" && current.association.basis === "appearance"
    ? current.association.referenceIds
    : [];
}
export function activitySupportVersions(
  current: z.infer<typeof memberActivityDataSchema>["attribution"]["current"],
) {
  if (current.kind === "unknown") return [];
  const association = current.association;
  return association.basis === "appearance"
    ? association.references.flatMap((reference) => [
        reference.referenceVersions,
        identityReferenceVersionsSchema.parse(reference.face.provenance),
      ])
    : [
        association.referenceVersions,
        ...association.evidence.map((evidence) =>
          identityReferenceVersionsSchema.parse(evidence.provenance),
        ),
      ];
}
