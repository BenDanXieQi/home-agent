import { useAtomValue } from "jotai";
import type { z } from "zod";
import type { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";

const states = {
  unknown: "未知",
  candidate: "疑似",
  confirmed: "已识别",
  inferred: "推测 · 人体外观匹配",
  conflict: "证据冲突",
};
type LiveIdentity = NonNullable<
  z.infer<typeof perceptionSnapshotSchema>["sources"][number]["identity"]
>;

function IdentityRow({
  associations,
  track,
}: {
  associations: z.infer<
    typeof perceptionSnapshotSchema
  >["sources"][number]["associations"];
  track: Pick<
    LiveIdentity["tracks"][number],
    "trackId" | "state" | "lastEvidenceAt"
  >;
}) {
  const association = associations.find(
    (item) => item.trackId === track.trackId,
  );
  const state =
    association?.state ?? (track.state === "conflict" ? "conflict" : "unknown");
  const observedAt = association?.observedAt ?? track.lastEvidenceAt;
  return (
    <li className="space-y-1 text-xs">
      <p className="font-medium">
        {association?.memberName ?? "未关联成员"} · 轨迹 {track.trackId}
      </p>
      {association ? (
        <p className="break-all text-muted">成员 ID：{association.memberId}</p>
      ) : null}
      <p>{states[state]}</p>
      <p className="text-muted">
        观察时间：
        {observedAt === null
          ? "暂无识别证据"
          : new Date(observedAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
    </li>
  );
}

export function CameraIdentity({
  source,
  frozen,
}: {
  source: ReturnType<typeof createPerceptionSourceState>;
  frozen: boolean;
}) {
  const identity = useAtomValue(source.identityAtom);
  const associations = useAtomValue(source.associationsAtom);
  const tracks = [
    ...(identity?.tracks ?? []),
    ...associations
      .filter(
        (association) =>
          !identity?.tracks.some(
            (track) => track.trackId === association.trackId,
          ),
      )
      .map((association) => ({
        trackId: association.trackId,
        state: "unknown" as const,
        lastEvidenceAt: association.observedAt,
      })),
  ];
  const unavailableMessage = useAtomValue(
    source.identityUnavailableMessageAtom,
  );
  return (
    <section
      className="space-y-3 rounded-xl border border-line p-4"
      aria-label="当前成员关联"
    >
      <h2 className="text-sm font-medium">当前成员关联</h2>
      <p className="text-xs leading-6 text-muted">
        {frozen
          ? "画面已定格；此面板仍实时更新，结果不属于定格画面。"
          : "实时后台结果，仅关联当前来源运行中的人宠轨迹。"}
      </p>
      {!identity && !associations.length ? (
        <p className="text-xs text-muted">{unavailableMessage}</p>
      ) : !tracks.length ? (
        <p className="text-xs text-muted">当前没有成员识别轨迹。</p>
      ) : (
        <ul className="space-y-3">
          {tracks.map((track) => (
            <IdentityRow
              key={track.trackId}
              associations={associations}
              track={track}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
