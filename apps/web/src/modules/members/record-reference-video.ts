import { identityEnrollmentLimits } from "@home-agent/api/contracts";

export function referenceRecordingSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    ["video/webm;codecs=vp8", "video/mp4"].some((type) =>
      MediaRecorder.isTypeSupported(type),
    )
  );
}

// Records only the already-authorized camera video; playback owns the source tracks.
export async function recordReferenceVideo(
  video: HTMLVideoElement,
  signal: AbortSignal,
  onElapsed: (milliseconds: number) => void,
  finishSignal: AbortSignal,
) {
  signal.throwIfAborted();
  const stream = video.srcObject;
  if (!(stream instanceof MediaStream) || video.readyState < 2 || video.paused)
    throw new Error("请等待摄像头画面就绪后再录制");
  const tracks = stream.getVideoTracks();
  if (
    !tracks.length ||
    tracks.some((track) => track.readyState !== "live" || track.muted)
  )
    throw new Error("摄像头视频已中断，请重新连接");
  const mimeType = ["video/webm;codecs=vp8", "video/mp4"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType)
    throw new Error(
      "当前浏览器不支持摄像头录制，请使用支持视频录制的浏览器或上传照片",
    );
  const recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: 2_000_000,
  });
  return await new Promise<Blob>((resolve, reject) => {
    const chunks: Blob[] = [];
    let bytes = 0;
    let complete = false;
    let settled = false;
    let startedAt = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearInterval(timer);
      clearTimeout(deadline);
      signal.removeEventListener("abort", aborted);
      finishSignal.removeEventListener("abort", finish);
      for (const track of tracks) {
        track.removeEventListener("ended", interrupted);
        track.removeEventListener("mute", interrupted);
      }
      recorder.removeEventListener("start", started);
      recorder.removeEventListener("dataavailable", data);
      recorder.removeEventListener("stop", stopped);
      recorder.removeEventListener("error", failed);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (recorder.state !== "inactive") recorder.stop();
      reject(error);
    };
    const aborted = () => fail(signal.reason);
    const interrupted = () =>
      fail(new Error("摄像头画面中断，本次录制未保存。请重新连接后录制。"));
    signal.addEventListener("abort", aborted, { once: true });
    for (const track of tracks) {
      track.addEventListener("ended", interrupted, { once: true });
      track.addEventListener("mute", interrupted, { once: true });
    }
    const finish = () => {
      if (settled || complete) return;
      complete = true;
      clearInterval(timer);
      clearTimeout(deadline);
      onElapsed(
        Math.min(
          identityEnrollmentLimits.captureMs,
          performance.now() - startedAt,
        ),
      );
      if (recorder.state !== "inactive") recorder.stop();
    };
    finishSignal.addEventListener("abort", finish, { once: true });
    const started = () => {
      if (complete) return;
      startedAt = performance.now();
      onElapsed(0);
      timer = setInterval(
        () =>
          onElapsed(
            Math.min(
              identityEnrollmentLimits.captureMs,
              performance.now() - startedAt,
            ),
          ),
        100,
      );
      deadline = setTimeout(finish, identityEnrollmentLimits.captureMs);
    };
    const data = (event: BlobEvent) => {
      bytes += event.data.size;
      if (bytes > identityEnrollmentLimits.recordingBytes) {
        fail(new Error("录像超过容量限制，请重新录制或上传照片"));
        return;
      }
      if (event.data.size) chunks.push(event.data);
    };
    const failed = () => fail(new Error("视频录制失败，请重新录制"));
    const stopped = () => {
      if (!complete || !bytes) {
        fail(new Error("录像未完成或没有有效画面，请重新录制"));
        return;
      }
      settled = true;
      cleanup();
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.addEventListener("start", started, { once: true });
    recorder.addEventListener("dataavailable", data);
    recorder.addEventListener("stop", stopped, { once: true });
    recorder.addEventListener("error", failed, { once: true });
    try {
      startedAt = performance.now();
      recorder.start(500);
      if (finishSignal.aborted) finish();
    } catch (error) {
      fail(error);
    }
  });
}
