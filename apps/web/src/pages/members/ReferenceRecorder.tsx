import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { RotateCcw } from "lucide-react";
import {
  identityEnrollmentLimits,
  type referenceMemberSchema,
  type referencePreviewSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { Select } from "../../components/Select";
import { devicesAtom } from "../../modules/devices/state";
import { PlaybackProvider } from "../../modules/playback/PlaybackProvider";
import { useMijiaPlayback } from "../../modules/playback/use-mijia-playback";
import { canStartPlaybackAtom } from "../../modules/playback/access";
import { mediaStateAtom } from "../../modules/playback/state";
import { createCameraAspectAtom } from "../../modules/playback/media-aspect";
import {
  recordReferenceVideo,
  referenceRecordingSupported,
} from "../../modules/members/record-reference-video";
import { extractRecording } from "../../modules/members/identity";
import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";
import { PlaybackStatus } from "../cameras/PlaybackStatus";
const recordingPrompts = ["请正对镜头", "请缓慢向左转头", "请缓慢向右转头"];

export function ReferenceRecorder({
  input,
  disabled,
  onPreview,
  onBusyChange,
  onCancel,
}: {
  input: z.infer<typeof referenceMemberSchema>;
  disabled: boolean;
  onPreview: (preview: z.infer<typeof referencePreviewSchema>) => void;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
}) {
  const devices = useAtomValue(devicesAtom);
  const [selected, select] = useState("");
  const [busy, setBusy] = useState(false);
  const changeBusy = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusyChange(value);
    },
    [onBusyChange],
  );
  const cameras = devices
    .filter((device) => device.camera)
    .flatMap((device) =>
      device.channels.map((channel) => ({
        deviceId: device.id,
        channel,
        label: `${device.name}${device.room_name ? ` · ${device.room_name}` : ""} · 镜头 ${channel}`,
      })),
    );
  const source = cameras.find(
    (camera) => `${camera.deviceId}:${camera.channel}` === selected,
  );
  return (
    <div className="space-y-4 rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">录制成员参考</h3>
          <p className="text-xs text-muted">
            选择摄像头 → 录制（最长 {identityEnrollmentLimits.captureMs / 1000}{" "}
            秒）→ 提取照片 → 挑选并保存
          </p>
        </div>
        <Button variant="ghost" size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
      <Select
        label="登记摄像头"
        placeholder="请选择摄像头"
        value={selected}
        disabled={busy}
        onValueChange={select}
        options={cameras.map((camera) => ({
          value: `${camera.deviceId}:${camera.channel}`,
          label: camera.label,
        }))}
      />
      {!cameras.length ? (
        <Notice>当前家庭设备清单中没有摄像头，可以上传成员照片。</Notice>
      ) : null}
      {source ? (
        <PlaybackProvider analysisActive={false}>
          <RecorderPreview
            key={selected}
            source={source}
            input={input}
            disabled={disabled}
            onPreview={onPreview}
            onBusyChange={changeBusy}
          />
        </PlaybackProvider>
      ) : (
        <p className="text-xs text-muted">
          所有家庭摄像头均可选择，无需预先开启后台检测。
        </p>
      )}
    </div>
  );
}

function RecorderPreview({
  source,
  input,
  disabled,
  onPreview,
  onBusyChange,
}: Pick<
  Parameters<typeof ReferenceRecorder>[0],
  "input" | "disabled" | "onPreview" | "onBusyChange"
> & {
  source: { deviceId: string; channel: 1 | 2; label: string };
}) {
  const canPlay = useAtomValue(canStartPlaybackAtom);
  const revision = useAtomValue(mediaStateAtom)?.revision;
  const [stage, setStage] = useState<"preview" | "recording" | "extracting">(
    "preview",
  );
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const finishRecording = useRef<AbortController | null>(null);
  const speech = useRef<SpeechSynthesisUtterance | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceError, setVoiceError] = useState("");
  const speechSupported =
    typeof speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined";
  const stopSpeech = useCallback(() => {
    if (!speech.current) return;
    speech.current = null;
    speechSynthesis.cancel();
  }, []);
  function speak(text: string) {
    stopSpeech();
    if (!voiceEnabled || !speechSupported) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    speech.current = utterance;
    utterance.addEventListener(
      "end",
      () => {
        if (speech.current === utterance) speech.current = null;
      },
      { once: true },
    );
    utterance.addEventListener(
      "error",
      () => {
        if (speech.current !== utterance) return;
        speech.current = null;
        setVoiceError("语音未能播放，请按画面上的文字提示录制。");
      },
      { once: true },
    );
    speechSynthesis.speak(utterance);
  }
  const { videoRef, snapshot, restart } = useMijiaPlayback(
    canPlay && revision && stage !== "extracting"
      ? {
          deviceId: source.deviceId,
          channel: source.channel,
          revision,
          scope_epoch: input.scope_epoch,
        }
      : null,
  );
  const busy = stage !== "preview";
  const supported = referenceRecordingSupported();
  const aspectAtom = useMemo(
    () => createCameraAspectAtom(source.deviceId, source.channel),
    [source.deviceId, source.channel],
  );
  const [aspectRatio, setAspectRatio] = useAtom(aspectAtom);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const updateAspectRatio = () => {
      if (video.videoWidth && video.videoHeight)
        setAspectRatio(video.videoWidth / video.videoHeight);
    };
    video.addEventListener("loadedmetadata", updateAspectRatio);
    video.addEventListener("resize", updateAspectRatio);
    updateAspectRatio();
    return () => {
      video.removeEventListener("loadedmetadata", updateAspectRatio);
      video.removeEventListener("resize", updateAspectRatio);
    };
  }, [videoRef, setAspectRatio]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.visibilityState !== "visible")
        controller.current?.abort(
          new Error("页面已离开，本次登记已取消，未保存照片。"),
        );
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      stopSpeech();
      onBusyChange(false);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [onBusyChange, stopSpeech]);
  useEffect(() => {
    if (stage === "recording" && snapshot.phase !== "playing")
      controller.current?.abort(new Error("摄像头连接已中断，请重新录制。"));
  }, [snapshot.phase, stage]);
  async function start() {
    const video = videoRef.current;
    if (!video || controller.current || disabled || !supported) return;
    const operation = new AbortController();
    const finish = new AbortController();
    finishRecording.current = finish;
    operation.signal.addEventListener("abort", stopSpeech, { once: true });
    controller.current = operation;
    setError("");
    setVoiceError("");
    setNotice("");
    setElapsed(0);
    setStage("recording");
    onBusyChange(true);
    const recordedAt = new Date().toISOString();
    try {
      let promptIndex = 0;
      speak(recordingPrompts[0]!);
      const blob = await recordReferenceVideo(
        video,
        operation.signal,
        (milliseconds) => {
          setElapsed(milliseconds);
          const next = Math.min(2, Math.floor(milliseconds / 5000));
          if (
            !finish.signal.aborted &&
            next !== promptIndex &&
            milliseconds < identityEnrollmentLimits.captureMs
          ) {
            promptIndex = next;
            speak(recordingPrompts[next]!);
          }
        },
        finish.signal,
      );
      operation.signal.throwIfAborted();
      setStage("extracting");
      speak("录制结束，正在提取照片，完成后请挑选并保存");
      const result = await extractRecording(
        {
          ...input,
          deviceId: source.deviceId,
          channel: source.channel,
          recordedAt,
        },
        blob,
        operation.signal,
      );
      if (mounted.current && !operation.signal.aborted) onPreview(result);
    } catch (cause) {
      stopSpeech();
      if (!mounted.current) return;
      if (operation.signal.aborted)
        setNotice(
          operation.signal.reason instanceof Error
            ? operation.signal.reason.message
            : "本次登记已取消，未保存照片。",
        );
      else
        setError(
          cause instanceof RequestError
            ? requestErrorMessage(cause)
            : cause instanceof Error
              ? cause.message
              : "录制失败，请重试",
        );
    } finally {
      controller.current = null;
      finishRecording.current = null;
      operation.signal.removeEventListener("abort", stopSpeech);
      if (mounted.current) {
        setStage("preview");
        onBusyChange(false);
      }
    }
  }
  return (
    <div className="space-y-3">
      <div
        className="relative w-full overflow-hidden rounded-xl bg-black"
        style={{ aspectRatio, maxWidth: `${50 * aspectRatio}dvh` }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 size-full object-contain"
          aria-label={`${source.label} 实时预览`}
        />
        {stage === "recording" ? (
          <div
            className="absolute bottom-3 left-3 rounded-lg bg-danger px-3 py-2 text-sm font-medium tabular-nums text-white"
            aria-live="polite"
          >
            ● 正在录制 {Math.floor(elapsed / 1000)} /{" "}
            {identityEnrollmentLimits.captureMs / 1000} 秒
          </div>
        ) : stage === "extracting" ? (
          <div
            className="absolute inset-0 grid place-content-center gap-2 bg-black/80 px-4 text-center text-white"
            aria-live="polite"
          >
            <p className="text-sm font-medium">录制已结束，正在提取参考照片…</p>
            <p className="text-xs text-white/70">
              提取完成后会自动进入照片挑选，当前尚未保存。
            </p>
          </div>
        ) : snapshot.phase !== "playing" ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/70">
            {snapshot.phase === "error" ? "暂时无法播放" : "等待摄像头画面"}
          </div>
        ) : null}
      </div>
      {stage === "recording" ? (
        <progress
          className="block h-2 w-full accent-red-500"
          max={identityEnrollmentLimits.captureMs}
          value={elapsed}
          aria-label="录制进度"
        />
      ) : null}
      {stage === "preview" ? (
        <div className="flex min-h-10 flex-wrap items-center gap-3 text-xs text-muted [&_.status-badge]:shrink-0 [&_p]:min-w-0 [&_p]:flex-1">
          <PlaybackStatus snapshot={snapshot} />
          {snapshot.phase === "error" ? (
            <Button
              type="button"
              className="ml-auto min-w-36 rounded-[10px]"
              icon={<RotateCcw size={15} />}
              onClick={restart}
            >
              重新播放
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted">
        请靠近摄像头，按照提示缓慢转头。最长录制{" "}
        {identityEnrollmentLimits.captureMs / 1000}{" "}
        秒，可随时提前结束并挑选照片，到时也会自动结束。
      </p>
      {stage === "recording" ? (
        <p className="text-sm font-medium" aria-live="polite">
          {recordingPrompts[Math.min(2, Math.floor(elapsed / 5000))]}
        </p>
      ) : null}
      <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="m-0 size-4 shrink-0 cursor-pointer p-0 accent-ink"
          checked={voiceEnabled && speechSupported}
          disabled={busy || !speechSupported}
          onChange={(event) => setVoiceEnabled(event.target.checked)}
        />
        <span>播放语音提示</span>
      </label>
      {!speechSupported || voiceError ? (
        <Notice>
          {voiceError || "当前浏览器不支持语音引导，请按文字提示录制。"}
        </Notice>
      ) : null}
      {!supported ? (
        <Notice tone="warning">
          当前浏览器不支持视频录制，请换用支持录制的浏览器或上传照片。
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice aria-live="polite">{notice}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {stage === "recording" ? (
          <Button
            onClick={() => {
              stopSpeech();
              finishRecording.current?.abort();
            }}
          >
            结束录制，挑选照片
          </Button>
        ) : null}
        {busy ? (
          <Button
            onClick={() =>
              controller.current?.abort(
                new Error("本次登记已取消，未保存照片。"),
              )
            }
          >
            {stage === "recording" ? "取消录制" : "取消提取"}
          </Button>
        ) : (
          <>
            <Button
              disabled={disabled || !supported || snapshot.phase !== "playing"}
              onClick={start}
            >
              开始录制
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
