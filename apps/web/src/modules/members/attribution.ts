import type {
  memberAssociationSchema,
  memberAttributionSnapshotSchema,
  attributionTriggerSchema,
  identityReferenceVersionsSchema,
} from "@home-agent/api/contracts";

export function attributionTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function associationLabel(
  association: ReturnType<typeof memberAssociationSchema.parse>,
) {
  if (association.basis === "appearance")
    return `推测是${association.memberName} · 人体外观匹配`;
  return `${association.memberName} · ${association.state === "confirmed" ? "已确认" : "疑似"} · ${association.basis === "pet" ? "宠物直接识别" : "人脸直接识别"}`;
}

export const revocationReasons = {
  face_conflict: "参照来源的人脸证据冲突",
  identity_replaced: "参照来源被直接识别为另一成员",
  terminal_identity_unavailable: "参照来源的结束身份无法核对",
};

export function attributionLabel(
  snapshot: ReturnType<typeof memberAttributionSnapshotSchema.parse>,
) {
  return snapshot.kind === "known"
    ? associationLabel(snapshot.association)
    : `未知 · 参照已撤销：${revocationReasons[snapshot.trigger.reason]}`;
}

export const correctionReasons = {
  member_changed: "成员归属改变",
  direct_confirmation: "推测升级为直接确认",
  reference_revoked: "参照撤销",
};

export function revocationEvidence(
  trigger: ReturnType<typeof attributionTriggerSchema.parse>,
) {
  const evidence = trigger.trigger;
  const references = `实际撤销参照：${trigger.references.map((reference) => `${reference.referenceId}（设备 ${reference.appearance.run.deviceId}，镜头 ${reference.appearance.run.channel}，运行 ${reference.appearance.run.runId}，媒体代次 ${reference.appearance.mediaTime.generation}，轨迹 ${reference.appearance.trackId}，帧 ${reference.appearance.sequence}，确认依据观察 ${attributionTime(reference.face.observedAt)}，${referenceVersionsLabel(reference.referenceVersions)}）`).join("；") || "无参照摘要"}。`;
  const summary = evidence
    ? `触发来源 ${evidence.observation.run.deviceId} · 镜头 ${evidence.observation.run.channel} · 运行 ${evidence.observation.run.runId} · 媒体代次 ${evidence.observation.mediaTime.generation} · 观察版本 ${evidence.observation.revision} · 帧 ${evidence.observation.sequence} · 轨迹 ${evidence.track.trackId} · ${evidence.track.state === "conflict" ? "人脸证据冲突" : "直接身份核对"}；证据 ${evidence.track.evidence.length} 份${evidence.omittedEvidence ? `（省略 ${evidence.omittedEvidence} 份）` : ""}；${evidence.track.evidence.map((item) => `证据 ${item.provenance.evidenceKey} · 观察 ${attributionTime(item.observedAt)} · 帧 ${item.provenance.sequence} · ${referenceVersionsLabel(item.provenance)}`).join("；")}`
    : `未保存触发身份摘要；${revocationReasons[trigger.reason]}。`;
  return `${summary} ${references}`;
}

export function referenceVersionsLabel(
  versions: ReturnType<typeof identityReferenceVersionsSchema.parse>,
) {
  return `参考内容 ${versions.contentVersion} · 资格 ${versions.eligibilityVersion} · 匹配 ${versions.matchingVersion} · 模型 ${versions.modelVersion} · 处理 ${versions.processingVersion}`;
}
