import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAtomValue } from "jotai";
import type { memberAssociationSchema } from "@home-agent/api/contracts";
import { devicesAtom } from "../modules/devices/state";
import {
  associationReason,
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
      <p>{associationReason(association)}</p>
      <details
        className="group/evidence"
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1.5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
          技术详情
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            aria-hidden="true"
            className="group-open/evidence:rotate-180"
          />
        </summary>
        {open ? (
          <div className="mt-2 space-y-1 rounded-lg bg-surface px-3 py-2">
            <p>成员 ID：{association.memberId}</p>
            <p>
              观察时间：{attributionTime(association.observedAt)} · 证据{" "}
              {association.evidence.length} 份 · 跟踪编号 {association.trackId}
            </p>
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
            {association.basis === "species" ? (
              <p>家庭资料版本：{association.eligibilityVersion}</p>
            ) : association.basis === "appearance" ? (
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
                      <p>参考画面 ID：{reference.referenceId}</p>
                      <p>
                        参考画面来源：
                        {sourceName(
                          reference.appearance.run.deviceId,
                          reference.appearance.run.channel,
                        )}{" "}
                        · 跟踪编号 {reference.appearance.trackId} · 帧{" "}
                        {reference.appearance.sequence}
                      </p>
                      <p>
                        人脸确认时间：
                        {attributionTime(reference.face.observedAt)} ·
                        人体外观采样时间：
                        {attributionTime(reference.observedAt)}
                      </p>
                      <p>
                        参考画面来源运行：{reference.appearance.run.runId} ·
                        媒体代次：
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
                      <p>
                        参考画面有效至：{attributionTime(reference.expiresAt)}
                      </p>
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
                  识别方式：
                  {association.basis === "pet"
                    ? "宠物照片匹配"
                    : "人脸照片匹配"}
                </p>
                <p>
                  最新匹配分数：
                  {association.evidence.at(-1)?.score?.toFixed(3) ?? "暂无"}
                  （匹配分数，不是身份概率）
                </p>
              </>
            )}
            <details>
              <summary className="cursor-pointer">采样证据明细</summary>
              <p>
                展示 {shownEvidence.length} 份采样证据
                {association.evidence.length > shownEvidence.length
                  ? `，另有 ${association.evidence.length - shownEvidence.length} 份未展示`
                  : ""}
                。
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
          </div>
        ) : null}
      </details>
    </div>
  );
}
