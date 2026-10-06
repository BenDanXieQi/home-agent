import type { PerceptionWindow } from "../../modules/perception/windows";
import {
  historicalIdentityStatuses,
  identityReasons,
  identityStates,
  windowTime,
} from "../../modules/perception/window-presentation";

type FrameIdentity = NonNullable<
  PerceptionWindow["frames"][number]["identity"]
>;

export function WindowIdentity({
  frames,
}: {
  frames: PerceptionWindow["frames"];
}) {
  return (
    <section
      aria-label="当时人物判断"
      className="space-y-3 border-t border-line pt-4"
    >
      <h4 className="text-sm font-medium">当时人物判断</h4>
      <p className="text-xs leading-5 text-muted">
        这里只显示每张保留帧当时已知的判断，后续识别不会改写历史。
        “当时识别尚未完成”不表示当前仍在等待。标签来自本地参考资料，不代表已核实的家庭成员身份。
      </p>
      {frames.length ? (
        <ol className="space-y-3">
          {frames.map((frame) => (
            <li
              key={frame.sequence}
              className="min-w-0 space-y-2 rounded-xl bg-surface p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <h5 className="font-medium tabular-nums">
                  {windowTime(frame.receivedAt)} · 保留帧 {frame.sequence}
                </h5>
                {frame.identity ? (
                  <span className="text-muted">
                    {historicalIdentityStatuses[frame.identity.status]}
                  </span>
                ) : null}
              </div>
              {frame.identity === null ? (
                <p className="text-xs leading-5 text-muted">
                  未收到这张帧对应的人物判断，无法据此判断当时是否有人。
                </p>
              ) : (
                <FrameJudgments identity={frame.identity} />
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs leading-5 text-muted">
          此窗口没有保留视频帧，无法展示当时的人物判断。
        </p>
      )}
    </section>
  );
}

function FrameJudgments({ identity }: { identity: FrameIdentity }) {
  return (
    <>
      <p className="text-xs leading-5 text-muted">
        快照时间 {windowTime(identity.evaluatedAt)}
        {identity.status === "disabled"
          ? null
          : identity.inference === "pending"
            ? " · 当时识别尚未完成"
            : " · 当时未为此帧提交新识别"}
      </p>
      {identity.tracks.length ? (
        <ul className="divide-y divide-line">
          {identity.tracks.map((track) => (
            <TrackJudgment key={track.trackId} track={track} />
          ))}
        </ul>
      ) : identity.status !== "disabled" ? (
        <p className="text-xs leading-5 text-muted">
          当时没有记录到人物判断；这不等于画面中无人。
        </p>
      ) : null}
    </>
  );
}

function TrackJudgment({ track }: { track: FrameIdentity["tracks"][number] }) {
  const reason = identityReasons.get(track.reason);
  return (
    <li className="space-y-1 py-2 text-xs first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-muted">人物轨迹 {track.trackId}</span>
        <strong className="font-medium">{identityStates[track.state]}</strong>
        {track.label !== null ? (
          <span className="min-w-0 break-all">本地标签：{track.label}</span>
        ) : null}
      </div>
      <p className="leading-5 text-muted">
        支持证据 {track.supportingSamples} 份{reason ? ` · ${reason}` : null}
        {track.lastEvidenceAt !== null
          ? ` · 最近证据 ${windowTime(track.lastEvidenceAt)}`
          : null}
      </p>
    </li>
  );
}
