import {
  petSoundLabels,
  petSoundStatuses,
} from "../../modules/perception/window-presentation";
import type { ExtractAtomValue } from "jotai";
import type { createPerceptionSourceState } from "../../modules/perception/source-state";

type AudioAnalysis = NonNullable<
  ExtractAtomValue<ReturnType<typeof createPerceptionSourceState>["audioAtom"]>
>;
type AudioTrack = NonNullable<AudioAnalysis["track"]>;

const audioStatus = {
  disabled: "音频分析未启用",
  starting: "正在准备音频分析",
  running: "音频分析运行中",
  unavailable: "音频分析不可用",
  closed: "音频分析已关闭",
};
const trackStatus = {
  starting: "正在准备音轨或等待采样",
  reading: "正在读取音轨",
  no_track: "来源没有可用音轨",
  failed: "音轨读取或解码失败",
  unavailable: "音轨不可用",
};
const validity = {
  no_data: "尚无结果",
  valid: "最近结果有效",
  expired: "最近结果已过期",
  unavailable: "链路或访问资格失效",
};
const vadStatus = {
  insufficient_input: "输入不足，尚未凑齐一块人声采样",
  ready: "可读取人声分块概率",
  unavailable: "人声模型未知或不可用",
};

export function CameraAudioAnalysis({ audio }: { audio: AudioAnalysis }) {
  const { track } = audio;
  return (
    <section
      className="space-y-3 rounded-xl bg-surface p-3"
      aria-label="声音分析"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">能量与人声检测</h3>
        <span className="text-xs text-muted">最近一批分块</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-6">
        <dt className="text-muted">音频服务</dt>
        <dd>{audioStatus[audio.status]}</dd>
        {track ? (
          <>
            <dt className="text-muted">音轨</dt>
            <dd>{trackStatus[track.status]}</dd>
            <dt className="text-muted">结果有效性</dt>
            <dd>{validity[track.validity]}</dd>
            <dt className="text-muted">人声分析</dt>
            <dd>{vadStatus[track.vadStatus]}</dd>
            {track.petSounds ? (
              <>
                <dt className="text-muted">猫狗声音</dt>
                <dd>
                  {track.petSounds.validity === "expired"
                    ? validity.expired
                    : petSoundStatuses[track.petSounds.status]}
                </dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {audio.error ? (
        <p className="break-words text-xs text-danger">{audio.error}</p>
      ) : null}
      {track?.error ? (
        <p className="break-words text-xs text-danger">{track.error}</p>
      ) : null}
      {track?.vadError ? (
        <p className="break-words text-xs text-danger">{track.vadError}</p>
      ) : null}
      {track?.petSounds?.error ? (
        <p className="text-xs text-danger">{track.petSounds.error}</p>
      ) : null}
      {track?.validity === "valid" &&
        track.petSounds?.validity === "valid" &&
        track.petSounds.status === "ready" &&
        track.petSounds?.chunks.map((chunk) => (
          <p key={chunk.startSample} className="text-xs">
            最近完成窗口 · {(chunk.startSample / 16000).toFixed(2)}–
            {(chunk.endSample / 16000).toFixed(2)} 秒：
            {chunk.detections.length
              ? chunk.detections
                  .map(
                    (detection) =>
                      `${petSoundLabels[detection.kind]} · ${detection.label} · 分数 ${detection.score.toFixed(3)}`,
                  )
                  .join("、")
              : "未检出猫狗声"}
          </p>
        ))}
      {track ? (
        <>
          <p className="text-xs leading-6 text-muted">
            区间为解码后音轨内的相对秒数。
            {track.channels.length > 1 ? "两个镜头共享此音轨结果。" : null}
            这里只显示最近一批分块，不能重建历史或判断整个 4
            秒窗口是否有人声；过期或失效分块不代表当前声音。
          </p>
          {track.energy.length ? (
            <AudioChunks
              title="声音能量"
              chunks={track.energy}
              sampleRate={track.sampleRate}
              description="数值为归一化均方根（RMS，即采样幅度的整体大小），不表示声音类别。"
            />
          ) : null}
          {track.vad.length ? (
            <AudioChunks
              title="人声概率"
              chunks={track.vad}
              sampleRate={track.sampleRate}
            />
          ) : null}
          {!track.energy.length && !track.vad.length ? (
            <p className="text-xs leading-6 text-muted">
              本批没有完整分块，不能判断有无声音或人声。
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs leading-6 text-muted">当前来源尚无音轨结果。</p>
      )}
    </section>
  );
}

function AudioChunks({
  title,
  chunks,
  sampleRate,
  description,
}: {
  title: string;
  chunks: AudioTrack["energy" | "vad"];
  sampleRate: AudioTrack["sampleRate"];
  description?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs tabular-nums">
        <caption className="pb-1 text-left font-medium">{title}</caption>
        <thead className="text-muted">
          <tr>
            <th scope="col" className="py-1 pr-3 font-normal">
              区间（秒）
            </th>
            <th scope="col" className="py-1 pr-3 font-normal">
              数值
            </th>
            <th scope="col" className="py-1 font-normal">
              分块结果
            </th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((chunk) => (
            <tr
              key={`${chunk.startSample}:${chunk.endSample}`}
              className="border-t border-line"
            >
              <td className="whitespace-nowrap py-1 pr-3 font-mono">
                {(chunk.startSample / sampleRate).toFixed(3)}–
                {(chunk.endSample / sampleRate).toFixed(3)}
              </td>
              <td className="whitespace-nowrap py-1 pr-3 font-mono">
                {"rms" in chunk
                  ? chunk.rms.toFixed(4)
                  : `${(chunk.probability * 100).toFixed(1)}%`}
              </td>
              <td className="py-1">
                {"active" in chunk
                  ? chunk.active
                    ? "超过能量阈值"
                    : "能量低于阈值"
                  : chunk.aboveThreshold
                    ? "人声概率达阈值"
                    : "人声概率未达阈值"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {description ? (
        <p className="mt-1 text-xs leading-6 text-muted">{description}</p>
      ) : null}
    </div>
  );
}
