import { useState } from "react";
import { useAtomValue } from "jotai";
import type { memberAssociationSchema } from "@home-agent/api/contracts";
import { devicesAtom } from "../modules/devices/state";
import {
  attributionTime,
  referenceVersionsLabel,
} from "../modules/members/attribution";

export function MemberAssociationEvidence({
  association,
}: {
  association: ReturnType<typeof memberAssociationSchema.parse>;
}) {
  const [open, setOpen] = useState(false);
  const shownEvidence = association.evidence.slice(0, 8);
  const devices = useAtomValue(devicesAtom);
  function sourceName(deviceId: string, channel: number) {
    const device = devices.find((item) => item.id === deviceId);
    return `${device?.name ?? deviceId} · 镜头 ${channel}（设备 ${deviceId}）`;
  }
  return (
    <div className="space-y-1 break-words text-xs leading-6 text-muted">
      <p>成员 ID：{association.memberId}</p>
      <p>
        观察：{attributionTime(association.observedAt)} · 证据{" "}
        {association.evidence.length} 份 · 轨迹 {association.trackId}
      </p>
      <details
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer">来源与技术依据</summary>
        {open ? (
          <>
            <p>
              来源：
              {sourceName(association.run.deviceId, association.run.channel)} ·
              运行 {association.sourceRunId}
            </p>
            <p>媒体代次：{association.mediaGeneration}</p>
            <p>
              支持帧：
              {shownEvidence
                .map((evidence) =>
                  "provenance" in evidence
                    ? evidence.provenance.sequence
                    : evidence.sequence,
                )
                .join("、")}
            </p>
            {association.basis === "appearance" ? (
              <>
                <p>
                  余弦相似度：{association.score.toFixed(3)} · 领先差值：
                  {association.margin.toFixed(3)}（匹配分数，不是身份概率）
                </p>
                <p>
                  策略：{association.policyVersion} · 推测有效至：
                  {attributionTime(association.expiresAt)}
                </p>
                <p>
                  人体模型／处理版本：
                  {[
                    ...new Set(
                      association.evidence.map(
                        (item) =>
                          `${item.modelVersion} / ${item.processingVersion}`,
                      ),
                    ),
                  ].join("；")}
                </p>
                <ul className="space-y-2">
                  {association.references.map((reference) => (
                    <li key={reference.referenceId}>
                      <p>实际参照：{reference.referenceId}</p>
                      <p>
                        参照来源：
                        {sourceName(
                          reference.appearance.run.deviceId,
                          reference.appearance.run.channel,
                        )}{" "}
                        · 轨迹 {reference.appearance.trackId} · 帧{" "}
                        {reference.appearance.sequence}
                      </p>
                      <p>
                        人脸确认依据观察：
                        {attributionTime(reference.face.observedAt)} ·
                        人体观察：{attributionTime(reference.observedAt)}
                      </p>
                      <p>
                        参照运行：{reference.appearance.run.runId} · 媒体代次：
                        {reference.appearance.mediaTime.generation}
                      </p>
                      <p>人脸证据：{reference.face.provenance.evidenceKey}</p>
                      <p>
                        人脸参考版本：
                        {referenceVersionsLabel(reference.referenceVersions)}
                      </p>
                      <p>
                        人体模型：{reference.appearance.modelVersion} · 处理：
                        {reference.appearance.processingVersion}
                      </p>
                      <p>参照有效至：{attributionTime(reference.expiresAt)}</p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p>
                  参考版本：
                  {referenceVersionsLabel(association.referenceVersions)}
                </p>
                <p>
                  {association.basis === "pet"
                    ? "宠物直接识别"
                    : "人脸直接识别"}
                  ：
                  {association.state === "confirmed"
                    ? "多次采样支持，系统已确认；不是人工确认。"
                    : "目标疑似该成员，直接识别依据尚不充分。"}
                </p>
              </>
            )}
            <details>
              <summary className="cursor-pointer">目标证据摘要</summary>
              <p>
                展示前 {shownEvidence.length} 份；省略{" "}
                {association.evidence.length - shownEvidence.length}{" "}
                份目标证据。保存的证据不变。
              </p>
              <ul className="space-y-1">
                {shownEvidence.map((item) => {
                  const key =
                    "provenance" in item
                      ? item.provenance.evidenceKey
                      : `${item.run.runId}:${item.mediaTime.generation}:${item.sequence}:${item.trackId}`;
                  return (
                    <li key={key}>
                      {key} · 观察{" "}
                      {attributionTime(
                        "observedAt" in item ? item.observedAt : item.sampledAt,
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          </>
        ) : null}
      </details>
    </div>
  );
}
