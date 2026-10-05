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
  return association.state === "confirmed"
    ? `系统识别为${association.memberName}`
    : `可能是${association.memberName}`;
}

export function associationObservation(
  association: ReturnType<typeof memberAssociationSchema.parse>,
) {
  const target =
    association.className === "human"
      ? "一个人"
      : association.className === "dog"
        ? "一只狗"
        : "一只猫";
  return `摄像头拍到${target}，${associationLabel(association)}。`;
}

export function associationReason(
  association: ReturnType<typeof memberAssociationSchema.parse>,
) {
  const name = association.memberName;
  if (association.basis === "species") {
    const species = association.className === "dog" ? "狗" : "猫";
    return `检测到${species}；家庭资料中只登记了${name}一只${species}。`;
  }
  if (association.basis === "appearance")
    return `人体外观与近期已确认是${name}的画面相似，仍未确认身份。`;
  if (association.basis === "pet") {
    if (association.state === "confirmed")
      return `多次猫狗参考照片的特征比对结果支持这是${name}。`;
    return `猫狗参考照片一起比较后，${name}的特征匹配分数最高，但还不能确认。`;
  }
  const recognition = "人脸";
  if (association.state === "confirmed")
    return `多次${recognition}识别结果支持这是${name}。`;
  if (association.state === "inferred")
    return `${recognition}匹配结果更接近${name}，暂未确认身份。`;
  return `${recognition}匹配指向${name}，但依据还不足以确认身份。`;
}

export const revocationReasons = {
  face_conflict: "之前作为依据的画面出现了不一致的人脸识别结果",
  target_face_conflict: "新的人脸识别结果与之前的判断不一致",
  identity_replaced: "之前作为依据的画面被识别为另一位成员",
  terminal_identity_unavailable: "无法核对之前作为依据的画面中的身份",
};

export function attributionLabel(
  snapshot: ReturnType<typeof memberAttributionSnapshotSchema.parse>,
) {
  return snapshot.kind === "known"
    ? associationLabel(snapshot.association)
    : "暂时无法确定是谁";
}

export function attributionObservation(
  snapshot: ReturnType<typeof memberAttributionSnapshotSchema.parse>,
) {
  return snapshot.kind === "known"
    ? associationObservation(snapshot.association)
    : "摄像头拍到一个人，暂时无法确定是谁。";
}

export function attributionReason(
  snapshot: ReturnType<typeof memberAttributionSnapshotSchema.parse>,
) {
  return snapshot.kind === "known"
    ? associationReason(snapshot.association)
    : `${revocationReasons[snapshot.trigger.reason]}，原来的身份判断已撤回。`;
}

export const correctionReasons = {
  member_changed: "身份匹配结果发生变化",
  direct_confirmation: "进一步识别后确认了身份",
  reference_revoked: "原来的判断依据已失效",
  target_face_conflict: "新的人脸识别结果与原判断不一致",
};

export function revocationEvidence(
  trigger: ReturnType<typeof attributionTriggerSchema.parse>,
) {
  const evidence = trigger.trigger;
  const references = `${trigger.reason === "target_face_conflict" ? "之前判断使用的参考画面（本次未撤销这些参考画面）" : "已撤销的参考画面"}：${trigger.references.map((reference) => `${reference.referenceId}（设备 ${reference.appearance.run.deviceId}，镜头 ${reference.appearance.run.channel}，运行 ${reference.appearance.run.runId}，媒体代次 ${reference.appearance.mediaTime.generation}，跟踪编号 ${reference.appearance.trackId}，帧 ${reference.appearance.sequence}，人脸确认时间 ${attributionTime(reference.face.observedAt)}，${referenceVersionsLabel(reference.referenceVersions)}）`).join("；") || "没有保存参考画面摘要"}。`;
  const summary = evidence
    ? `触发来源 ${evidence.observation.run.deviceId} · 镜头 ${evidence.observation.run.channel} · 运行 ${evidence.observation.run.runId} · 媒体代次 ${evidence.observation.mediaTime.generation} · 观察版本 ${evidence.observation.revision} · 帧 ${evidence.observation.sequence} · 轨迹 ${evidence.track.trackId} · ${evidence.track.state === "conflict" ? "人脸证据冲突" : "直接身份核对"}；证据 ${evidence.track.evidence.length} 份${evidence.omittedEvidence ? `（省略 ${evidence.omittedEvidence} 份）` : ""}；${evidence.track.evidence.map((item) => `证据 ${item.provenance.evidenceKey} · 观察 ${attributionTime(item.observedAt)} · 帧 ${item.provenance.sequence} · ${referenceVersionsLabel(item.provenance)}`).join("；")}`
    : `未保存触发身份摘要；${revocationReasons[trigger.reason]}。`;
  return `${summary} ${references}`;
}

export function referenceVersionsLabel(
  versions: ReturnType<typeof identityReferenceVersionsSchema.parse>,
) {
  return `识别快照 ${versions.revision} · 模型 ${versions.modelVersion} · 处理 ${versions.processingVersion}`;
}
