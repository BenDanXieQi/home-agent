import { useEffect, useState } from "react";
import type { PerceptionWindow } from "../../modules/perception/windows";
import { windowTime } from "./window-presentation";

export function WindowSpeech({ window }: { window: PerceptionWindow }) {
  const { speech } = window;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!speech.enabled) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, speech.acceptingUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [speech.enabled, speech.acceptingUntil]);
  const accepting = now < speech.acceptingUntil;
  return (
    <section
      aria-label="窗口语音文字"
      className="space-y-3 border-t border-line pt-4"
    >
      <h4 className="text-sm font-medium">语音文字</h4>
      {!speech.enabled ? (
        <p className="text-xs text-muted">当时未开启语音转写。</p>
      ) : (
        <>
          <p className="text-xs leading-5 text-muted">
            显示与本窗口相交的完整语音段。跨窗口的语音会重复展示；文字没有逐字时间，也未关联说话人身份。
          </p>
          {speech.segments.length ? (
            <ol className="space-y-3">
              {speech.segments.map((segment) => (
                <li
                  key={segment.id}
                  className="space-y-2 rounded-xl bg-surface p-3"
                >
                  <p className="text-xs tabular-nums text-muted">
                    {windowTime(segment.observedStartAt)} –{" "}
                    {windowTime(segment.observedEndAt)}
                    {segment.observedStartAt < window.startedAt
                      ? " · 从上一窗口延续"
                      : ""}
                    {segment.observedEndAt > window.endedAt
                      ? " · 延续到下一窗口"
                      : ""}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">
                    {segment.text}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">
              {accepting
                ? "等待这个时段的转写结果，完整语音可能在窗口结束后才识别完成。"
                : "没有保留下来的转写文字；这不代表当时没有人讲话。"}
            </p>
          )}
          {accepting && speech.segments.length ? (
            <p className="text-xs text-muted">此窗口仍可补充稍后完成的转写。</p>
          ) : null}
          {speech.truncated ? (
            <p className="text-xs text-muted">
              转写条数已达保留上限，记录不完整。
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
