import { z } from "zod";
import type { mediaAnalysisCompletedSchema } from "@home-agent/agent/media-analysis/session";
import {
  createBackendClient,
  readRecordingMediaResponse,
} from "@home-agent/backend-client";
import type { ContextSource } from "@home-agent/agent/context/source";
import type { createMediaAnalysisAgent } from "@home-agent/agent/media-analysis";
import { formatMediaTime } from "@home-agent/agent/media-analysis/analysis";
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
    const content: Awaited<ReturnType<typeof readMedia>> = [];
    if (range.kind === "video") {
      const response = await api.recordings.media.$post(
        {
          json: {
            deviceId: range.source.deviceId,
            channel: range.source.channel,
            source: "local",
            selection: {
              kind: "range",
              start: range.startedAt,
              end: range.endedAt,
            },
            output: {
              kind: "video",
              codec: "h264",
              fps: 1,
              height: 512,
            },
          },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new AppError("perception_media_unavailable");
      const bytes = await readLimitedBytes(response, 64 * 1024 * 1024, signal);
      const result = await readRecordingMediaResponse(
        new Response(bytes, { headers: response.headers }),
        signal,
      );
      const video = result.media[0];
      if (
        result.media.length !== 1 ||
        video?.type !== "video/mp4" ||
        result.startedAt === undefined ||
        result.endedAt === undefined
      )
        throw new Error("Expected one original recording video");
      content.push(
        {
          type: "text",
          text: `原片读取区间：${formatMediaTime(result.startedAt)} 至 ${formatMediaTime(result.endedAt)}，视频无音轨。`,
        },
        {
          type: "media",
          media: {
            kind: "video",
            data: new Uint8Array(await video.arrayBuffer()),
            fps: 1,
          },
        },
      );
    }

    if (!range.includeAudio) return content;
    const response = await api.dynamics.audio.$post(
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
    const data = await readLimitedBytes(response, 64 * 1024 * 1024, signal);
    if (!data.length || response.headers.get("content-type") !== "audio/mp4")
      throw new Error("Expected continuous range audio");
    content.push(
      {
        type: "text",
        text: `独立声音：${formatMediaTime(range.startedAt)} 至 ${formatMediaTime(range.endedAt)}。`,
      },
      {
        type: "media",
        media: {
          kind: "audio",
          data,
        },
      },
    );
    return content;
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
