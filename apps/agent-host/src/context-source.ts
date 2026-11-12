import { z } from "zod";
import type { mediaAnalysisCompletedSchema } from "@home-agent/agent/media-analysis/session";
import {
  createBackendClient,
  readRecordingMediaResponse,
} from "@home-agent/backend-client";
import type { ContextSource } from "@home-agent/agent/context/source";
import type { createMediaAnalysisAgent } from "@home-agent/agent/media-analysis";
import { formatMediaTime } from "@home-agent/agent/media-analysis/analysis";
import type { readCameraMediaSchema } from "@home-agent/agent/media-analysis/extension";
import { tracedFetch } from "@home-agent/observability";
import { partial } from "es-toolkit";
import { readLimitedBytes } from "@home-agent/api/http/read-body";
import { requestJson } from "@home-agent/api/http/request-json";
import { AppError } from "@home-agent/api/errors";

export function createContextSource(backendUrl: string) {
  const api = createBackendClient(backendUrl, {
    fetch: partial(tracedFetch, { from: "agent", to: "backend" }),
  }).api.agent.context;
  return {
    stream: (signal) =>
      api.stream.$get(
        {},
        {
          init: { headers: { Accept: "text/event-stream" }, signal },
        },
      ),
    history: (input, signal) =>
      api.history.$post({ json: input }, { init: { signal } }),
    material: (input, signal) =>
      api.material.$post({ json: input }, { init: { signal } }),
  } satisfies ContextSource;
}

export function createMediaReader(backendUrl: string) {
  const api = createBackendClient(backendUrl, {
    fetch: partial(tracedFetch, { from: "agent", to: "backend" }),
  }).api;
  const readMedia: Parameters<
    typeof createMediaAnalysisAgent
  >[0]["readMedia"] = async (range, requestSignal) => {
    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(30_000),
    ]);
    const response = await api.dynamics.media.$post(
      {
        json: {
          source: range.source,
          startedAt: range.startedAt,
          endedAt: range.endedAt,
          kind: range.kind,
          includeAudio: range.includeAudio,
        },
      },
      { init: { signal } },
    );
    if (!response.ok) throw new AppError("perception_media_unavailable");
    const contentType = range.kind === "video" ? "video/mp4" : "audio/mpeg";
    const data = await readLimitedBytes(response, 64 * 1024 * 1024, signal);
    const start = response.headers.get("x-media-started-at");
    const end = response.headers.get("x-media-ended-at");
    const startedAt = Number(start);
    const endedAt = Number(end);
    if (
      !data.length ||
      response.headers.get("content-type") !== contentType ||
      start === null ||
      end === null ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      startedAt >= endedAt
    )
      throw new Error("Expected continuous range media");

    const description =
      range.kind === "audio"
        ? "仅提供 MP3 音频。"
        : range.includeAudio
          ? "视频包含同期音轨，音视频同步精度未知。"
          : "视频无音轨。";
    return [
      {
        type: "text",
        text: `媒体区间：${formatMediaTime(startedAt)} 至 ${formatMediaTime(endedAt)}。${description}`,
      },
      {
        type: "media",
        media:
          range.kind === "video"
            ? { kind: "video", data, fps: 1 }
            : { kind: "audio", data },
      },
    ];
  };
  return readMedia;
}

export function createAnalysisWriter(backendUrl: string) {
  return async (
    entry: z.infer<typeof mediaAnalysisCompletedSchema>,
    signal: AbortSignal,
  ) => {
    await requestJson(
      (requestSignal) =>
        tracedFetch(
          { from: "agent", to: "backend" },
          new URL("/api/dynamics/completed", backendUrl),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
            signal: requestSignal,
            redirect: "error",
          },
        ),
      z.object({ saved: z.literal(true) }),
      { signal, timeoutMs: 15_000, unavailableCode: "agent_unavailable" },
    );
  };
}

export function createCameraMediaReader(backendUrl: string) {
  const api = createBackendClient(backendUrl, {
    fetch: partial(tracedFetch, { from: "agent", to: "backend" }),
  }).api;
  return async (
    input: z.infer<typeof readCameraMediaSchema>,
    requestSignal: AbortSignal,
  ) => {
    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(30_000),
    ]);
    const response = await api.recordings.media.$post(
      {
        json: {
          deviceId: input.source.deviceId,
          channel: input.source.channel,
          source: "local",
          selection: {
            kind: "range",
            start: input.startedAt,
            end: input.endedAt,
          },
          output: { kind: "video", codec: "h264", fps: 1, height: 512 },
        },
      },
      { init: { signal } },
    );
    if (!response.ok) throw new AppError("perception_media_unavailable");

    const maxBytes = 64 * 1024 * 1024;
    const bytes = await readLimitedBytes(
      response,
      maxBytes + 64 * 1024,
      signal,
    );
    const { media, startedAt, endedAt, hasAudio } =
      await readRecordingMediaResponse(
        new Response(bytes, { headers: response.headers }),
        signal,
      );
    const video = media[0];
    if (
      media.length !== 1 ||
      !video ||
      video.type !== "video/mp4" ||
      !video.size ||
      video.size > maxBytes ||
      startedAt === undefined ||
      endedAt === undefined ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      startedAt >= endedAt ||
      hasAudio === undefined
    )
      throw new Error("Expected one continuous local recording video");

    const data = new Uint8Array(await video.arrayBuffer());
    signal.throwIfAborted();
    return {
      startedAt,
      endedAt,
      includeAudio: hasAudio,
      content: [
        {
          type: "text" as const,
          text: `媒体区间：${formatMediaTime(startedAt)} 至 ${formatMediaTime(endedAt)}。${hasAudio ? "视频包含同期音轨，音视频同步精度未知。" : "视频无音轨。"}`,
        },
        {
          type: "media" as const,
          media: { kind: "video" as const, data, fps: 1 },
        },
      ],
    };
  };
}
