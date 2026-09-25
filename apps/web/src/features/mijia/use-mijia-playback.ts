import { useEffect, useRef, useState } from "react";
import { mijiaTimeouts } from "@home-agent/api/mijia";
import { RequestError, requestErrorMessage } from "../../lib/api";
import {
  reserveMijiaPlayback,
  offerMijiaPlayback,
  releaseMijiaPlayback,
} from "./api";

type PlaybackStatus = {
  phase: "connecting" | "waiting" | "playing" | "hidden" | "error";
  message: string;
};

const initialStatus: PlaybackStatus = {
  phase: "connecting",
  message: "正在建立浏览器播放连接…",
};

async function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(new RequestError({ code: "ice_gathering_timeout" }));
    }, mijiaTimeouts.iceGathering);
    function finish() {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal.removeEventListener("abort", onAbort);
    }
    function onChange() {
      if (peer.iceGatheringState !== "complete") return;
      finish();
      resolve();
    }
    function onAbort() {
      finish();
      reject(new DOMException("Playback stopped", "AbortError"));
    }
    peer.addEventListener("icegatheringstatechange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else onChange();
  });
}

export function useMijiaPlayback({
  revision,
  deviceId,
  channel,
}: {
  revision: string;
  deviceId: string;
  channel: 1 | 2;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<PlaybackStatus>(initialStatus);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let stopped = false;
    let peer: RTCPeerConnection | undefined;
    let playbackId: string | undefined;
    let frameCallback: number | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let negotiationDeadline: ReturnType<typeof setTimeout> | undefined;
    let visibilityObserver: IntersectionObserver | undefined;
    let inViewport = false;
    let visible = false;
    let negotiated = false;
    let hasPresentedFrame = false;
    let waitingForVisibleFrame = true;
    let frameDeadline = 0;
    const controller = new AbortController();
    let stream: MediaStream | undefined;

    function stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      clearInterval(watchdog);
      clearTimeout(negotiationDeadline);
      visibilityObserver?.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      if (frameCallback !== undefined)
        video!.cancelVideoFrameCallback(frameCallback);
      peer?.close();
      for (const track of stream?.getTracks() ?? []) track.stop();
      video!.pause();
      video!.srcObject = null;
      video!.load();
      if (playbackId) {
        releaseMijiaPlayback(playbackId);
        playbackId = undefined;
      }
    }

    function fail(message: string) {
      if (stopped) return;
      setStatus({ phase: "error", message });
      stop();
    }

    function waitForFrame() {
      waitingForVisibleFrame = true;
      frameDeadline =
        performance.now() +
        (hasPresentedFrame
          ? mijiaTimeouts.stalledFrame
          : mijiaTimeouts.firstFrame);
      setStatus({
        phase: "waiting",
        message: hasPresentedFrame
          ? `预览已恢复可见，等待新画面（最长 ${mijiaTimeouts.stalledFrame / 1000} 秒）…`
          : `播放协商已完成，等待首帧（最长 ${mijiaTimeouts.firstFrame / 1000} 秒）…`,
      });
    }

    function updateVisibility() {
      if (stopped) return;
      const nextVisible = document.visibilityState === "visible" && inViewport;
      if (nextVisible === visible) return;
      visible = nextVisible;
      waitingForVisibleFrame = true;
      if (!visible) {
        frameDeadline = 0;
        setStatus({
          phase: "hidden",
          message: "预览当前不可见，恢复可见后继续检测画面。",
        });
      } else if (negotiated) {
        waitForFrame();
      } else {
        setStatus(initialStatus);
      }
    }

    function onFrame() {
      if (stopped) return;
      if (visible && document.visibilityState === "visible") {
        hasPresentedFrame = true;
        frameDeadline = performance.now() + mijiaTimeouts.stalledFrame;
        if (waitingForVisibleFrame) {
          waitingForVisibleFrame = false;
          setStatus({ phase: "playing", message: "已收到并显示摄像头画面" });
        }
      }
      frameCallback = video!.requestVideoFrameCallback(onFrame);
    }

    async function connect() {
      if (
        typeof RTCPeerConnection !== "function" ||
        typeof MediaStream !== "function" ||
        typeof video!.requestVideoFrameCallback !== "function"
      ) {
        fail(
          "当前浏览器缺少 WebRTC 或视频出帧检测能力，请使用现代浏览器打开本机页面。",
        );
        return;
      }
      try {
        document.addEventListener("visibilitychange", updateVisibility);
        visibilityObserver = new IntersectionObserver(
          ([entry]) => {
            if (stopped || !entry) return;
            inViewport = entry.isIntersecting && entry.intersectionRatio > 0;
            updateVisibility();
          },
          { threshold: [0, 0.01] },
        );
        visibilityObserver.observe(video!);
        negotiationDeadline = setTimeout(() => {
          fail(
            `${mijiaTimeouts.negotiation / 1000} 秒内未能完成播放协商，请检查摄像头与本机网络后重试。`,
          );
        }, mijiaTimeouts.negotiation);
        stream = new MediaStream();
        peer = new RTCPeerConnection({ iceServers: [] });
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addEventListener(
          "track",
          (event) => {
            if (stopped) return;
            stream!.addTrack(event.track);
            event.track.addEventListener(
              "ended",
              () => {
                fail("摄像头视频轨道已结束，请重新播放。");
              },
              { signal: controller.signal },
            );
            video!.srcObject = stream!;
            void video!.play().catch(() => {
              fail("浏览器未能开始播放视频，请点击重新播放。");
            });
          },
          { signal: controller.signal },
        );
        peer.addEventListener(
          "connectionstatechange",
          () => {
            if (peer?.connectionState === "failed")
              fail(
                "WebRTC 连接失败，请检查 go2rtc 的 8555 端口及本机候选地址。",
              );
          },
          { signal: controller.signal },
        );
        frameCallback = video!.requestVideoFrameCallback(onFrame);
        // Reserve an ID before sending SDP so teardown can cancel an offer even
        // when its response never arrives. Reservation itself does not touch media.
        const [reservation] = await Promise.all([
          reserveMijiaPlayback({ revision, deviceId, channel }).then(
            (result) => {
              if (stopped) releaseMijiaPlayback(result.id);
              else playbackId = result.id;
              return result;
            },
          ),
          (async () => {
            await peer.setLocalDescription(await peer.createOffer());
            if (stopped) return;
            await gatherIce(peer, controller.signal);
          })(),
        ]);
        if (stopped) return;
        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new RequestError({ code: "missing_local_sdp" });
        const result = await offerMijiaPlayback(
          reservation.id,
          { revision, sdp },
          controller.signal,
        );
        if (stopped) return;
        await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
        if (stopped) return;
        clearTimeout(negotiationDeadline);
        negotiated = true;
        if (!visible) {
          setStatus({
            phase: "hidden",
            message: "预览当前不可见，恢复可见后继续检测画面。",
          });
        } else if (waitingForVisibleFrame) {
          waitForFrame();
        }
        watchdog = setInterval(() => {
          if (stopped || !visible || document.visibilityState !== "visible")
            return;
          const now = performance.now();
          if (!hasPresentedFrame && now >= frameDeadline) {
            fail(
              `${mijiaTimeouts.firstFrame / 1000} 秒内没有收到可显示的首帧。请确认摄像头在线、视频编码受浏览器支持，并重试。`,
            );
          } else if (hasPresentedFrame && now >= frameDeadline) {
            fail(
              `摄像头画面已连续 ${mijiaTimeouts.stalledFrame / 1000} 秒没有更新，播放已停止。请检查设备和网络后重新播放。`,
            );
          }
        }, 1_000);
      } catch (error) {
        if (stopped) return;
        fail(
          !(error instanceof RequestError)
            ? "播放协商失败，请检查摄像头和浏览器连接后重试。"
            : requestErrorMessage(error),
        );
      }
    }

    void connect();
    return stop;
  }, [revision, deviceId, channel]);

  return { videoRef, status };
}
