import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  mediaAnalysisEntrySchema,
  mediaAnalysisCompletedSchema,
} from "./session";
import type { z } from "zod";
import { attemptAsync, memoize } from "es-toolkit";
import type { agentContextDataSchemas } from "@home-agent/api/agent-context";
import { AppError } from "@home-agent/api/errors";
import {
  observeAgentOperation,
  withGenAiContext,
} from "@home-agent/observability";
import { createAgentDeviceMetadata } from "../context/devices";
import type { createContextReader } from "../context/reader";
import type { createContextReceiver } from "../context/receiver";
import { observationBinding, observationTarget } from "../context/spatial";
import {
  formatMediaTime,
  type createMediaAnalyzer,
  type MediaAnalysisInput,
} from "./analysis";

const audioOnlyAnalysisEnabled = false;

export function createMediaAnalysisAgent({
  readParts,
  contextReader,
  analyze,
  readMedia,
  saveCompleted,
}: {
  readParts: ReturnType<typeof createContextReceiver>["currentParts"];
  contextReader: Pick<ReturnType<typeof createContextReader>, "readCurrent">;
  saveCompleted: (
    entry: z.infer<typeof mediaAnalysisCompletedSchema>,
    signal: AbortSignal,
  ) => Promise<void>;
  analyze: ReturnType<typeof createMediaAnalyzer>["analyze"];
  readMedia: (
    range: z.infer<typeof mediaAnalysisEntrySchema>,
    signal: AbortSignal,
  ) => Promise<MediaAnalysisInput["content"]>;
}) {
  const admitted = new Map<
    string,
    { through: number; expiresAt: number; pendingId: string | undefined }
  >();
  const entries = new Map<string, z.infer<typeof mediaAnalysisEntrySchema>>();
  const listeners = new Map<string, Set<() => void>>();
  let currentMedia:
    | {
        id: string;
        blocks: Extract<
          MediaAnalysisInput["content"][number],
          { type: "media" }
        >[];
      }
    | undefined;

  function publish(id: string, list = true) {
    for (const listener of listeners.get(id) ?? []) listener();
    if (list) for (const listener of listeners.get("*") ?? []) listener();
  }

  function snapshot() {
    return {
      enabled: true,
      entries: [...entries.values()].map(
        ({ reply, reasoning: _reasoning, media: _media, ...entry }) => ({
          ...entry,
          summary: reply.slice(0, 240),
        }),
      ),
    };
  }

  function update(
    id: string,
    patch: Partial<z.infer<typeof mediaAnalysisEntrySchema>>,
    list = true,
  ) {
    const entry = entries.get(id);
    if (!entry) return;
    Object.assign(entry, patch);
    publish(id, list);
  }

  function trim() {
    const settled = [...entries.values()].filter((entry) =>
      ["completed", "failed", "expired"].includes(entry.status),
    );
    for (const entry of settled.slice(0, Math.max(0, settled.length - 30)))
      entries.delete(entry.id);
  }
  let started = false;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let closed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function admit() {
    const now = Date.now();
    for (const [id, range] of admitted) {
      if (now >= range.expiresAt) admitted.delete(id);
    }
    for (const entry of entries.values()) {
      if (
        ["collecting", "queued"].includes(entry.status) &&
        now >= entry.readableUntil
      )
        update(entry.id, {
          status: "expired",
          error: "媒体已过期，未进行分析",
        });
    }
    const observations = readParts()?.observations;
    const ranges: z.infer<
      typeof agentContextDataSchemas.observations
    >["media_ranges"] =
      observations?.status === "ready" ? observations.data.media_ranges : [];
    for (const {
      id: rangeId,
      ready,
      settledAt: _settledAt,
      ...range
    } of ranges) {
      if (range.kind === "audio" && !audioOnlyAnalysisEnabled) continue;
      if (now >= range.readableUntil) continue;
      const admission = admitted.get(rangeId) ?? {
        through: range.startedAt,
        expiresAt: range.readableUntil,
        pendingId: undefined,
      };
      admitted.set(rangeId, admission);
      admission.expiresAt = range.readableUntil;
      if (range.endedAt <= admission.through) continue;
      const pending = admission.pendingId && entries.get(admission.pendingId);
      const status = ready ? ("queued" as const) : ("collecting" as const);
      if (pending && ["collecting", "queued"].includes(pending.status)) {
        update(pending.id, { ...range, startedAt: admission.through, status });
        continue;
      }
      const background = readBackground();
      const camera = createAgentDeviceMetadata(background?.household).device({
        device_id: range.source.deviceId,
      });
      const target =
        background &&
        observationTarget(background.spatial, range.source, admission.through);
      const id = crypto.randomUUID();
      admission.pendingId = id;
      entries.set(id, {
        ...range,
        id,
        startedAt: admission.through,
        queuedAt: now,
        status,
        deviceName: camera.device_name ?? "摄像头",
        location: target?.name ?? camera.room_name ?? "未知位置",
        analysisStartedAt: null,
        completedAt: null,
        reply: "",
        reasoning: "",
        error: null,
        media: [],
      });
      publish(id);
    }
    trim();
    clearTimeout(expiryTimer);
    const deadlines = [...entries.values()]
      .filter((entry) => ["collecting", "queued"].includes(entry.status))
      .map((entry) => entry.readableUntil);
    if (deadlines.length)
      expiryTimer = setTimeout(
        admit,
        Math.max(1, Math.min(...deadlines) - Date.now()),
      );
  }

  function readBackground() {
    const parts = readParts();
    if (
      parts?.members?.status !== "ready" ||
      parts.spatial?.status !== "ready" ||
      parts.household?.status !== "ready"
    )
      return;

    return {
      members: parts.members.data.members,
      spatial: parts.spatial.data,
      household: parts.household,
    };
  }

  async function analyzeRange(
    id: string,
    signal: AbortSignal,
    {
      members,
      spatial,
      household,
    }: NonNullable<ReturnType<typeof readBackground>>,
  ) {
    const range = detail(id);
    const media = await readMedia(range, signal);
    signal.throwIfAborted();
    const blocks = media.filter((block) => block.type === "media");
    currentMedia = { id, blocks };
    update(id, {
      status: "analyzing",
      media: blocks.map((block, index) => ({
        index,
        kind: block.media.kind,
        contentType: block.media.kind === "video" ? "video/mp4" : "audio/mp4",
      })),
    });

    const devices = createAgentDeviceMetadata(household);
    const spaceName = (spaceId: string) =>
      spatial.spaces.find((space) => space.id === spaceId)?.name ?? "未知空间";
    const source = range.source;
    const at = range.startedAt;
    const camera = devices.device({ device_id: source.deviceId });
    const binding = observationBinding(spatial, source, at);
    const target = observationTarget(spatial, source, at);
    update(id, {
      deviceName: camera.device_name ?? "摄像头",
      location: target?.name ?? camera.room_name ?? "未知位置",
    });
    const content: MediaAnalysisInput["content"] = [
      {
        type: "text",
        text: [
          "时间约定：以下日期和时刻均按服务运行环境的本地时区标注，包含 GMT 偏移；描述事件时使用所标注的时区。",
          `本次实际输入：${blocks.some((block) => block.media.kind === "video") ? "包含视频画面" : "未提供画面"}；${blocks.some((block) => block.media.kind === "audio") ? "包含音频" : "未提供声音"}。`,
          "以下是背景资料，不是本次事件的观察结果。",
          "家庭成员资料（不表示本次在场）：",
          ...members.map(
            (member) =>
              `${member.name}（${member.kind === "pet" ? member.species : member.gender === "male" ? "男" : member.gender === "female" ? "女" : "人物"}）：${member.description}`,
          ),
          "家庭空间：",
          ...spatial.spaces.map(
            (space) => `${space.name}：${space.description}`,
          ),
          ...spatial.passages.map(
            (passage) =>
              `${passage.name}（连接${spaceName(passage.space_a_id)}与${spaceName(passage.space_b_id)}）：${passage.description}`,
          ),
        ].join("\n"),
      },
      {
        type: "text",
        text: `以下媒体来自${camera.device_name ?? "未知摄像头"}的镜头 ${source.channel}；所在房间：${camera.room_name ?? "未知"}；观测区域：${target?.name ?? "未知"}；镜头描述：${binding?.description ?? "未提供该时刻的描述"}；时间：${formatMediaTime(at)} 至 ${formatMediaTime(range.endedAt)}。`,
      },
      ...media,
    ];
    const sessionId = crypto.randomUUID();
    const reply = await withGenAiContext(
      { "session.id": sessionId, "gen_ai.conversation.id": sessionId },
      () =>
        observeAgentOperation(
          "media-analysis-agent",
          content.filter((block) => block.type === "text"),
          () =>
            analyze({
              content,
              signal,
              receive: (kind, delta) => {
                signal.throwIfAborted();
                const entry = entries.get(id);
                if (entry) update(id, { [kind]: entry[kind] + delta }, false);
              },
            }),
          {
            onStart: (span) => {
              span.setAttribute(
                "home_agent.media_analysis.media_count",
                blocks.length,
              );
            },
            onComplete: (_span, result) => result,
          },
        ),
    );
    signal.throwIfAborted();
    update(id, { status: "saving", reply });
    const completed = mediaAnalysisCompletedSchema.parse({
      ...entries.get(id),
      status: "completed",
      completedAt: Date.now(),
    });
    await saveCompleted(completed, signal);
    signal.throwIfAborted();
    update(id, completed);
    trim();
  }

  async function runRange(
    id: string,
    background: NonNullable<ReturnType<typeof readBackground>>,
  ) {
    const rangeGeneration = generation;
    update(id, {
      status: "preparing",
      analysisStartedAt: Date.now(),
      error: null,
      reply: "",
      reasoning: "",
      media: [],
    });
    const lifecycle = new AbortController();
    controller = lifecycle;
    const requestSignal = AbortSignal.any([
      lifecycle.signal,
      AbortSignal.timeout(120_000),
    ]);
    let contextSignal: AbortSignal | undefined;
    const [error] = await attemptAsync(() =>
      contextReader.readCurrent(requestSignal, (signal) => {
        contextSignal = signal;
        return analyzeRange(id, signal, background);
      }),
    );
    if (controller === lifecycle) controller = undefined;
    if (rangeGeneration !== generation || closed || !error) return;

    const disconnected =
      !requestSignal.aborted && (!contextSignal || contextSignal.aborted);
    if (disconnected && entries.has(id))
      update(id, {
        status: "queued",
        reply: "",
        reasoning: "",
        media: [],
        analysisStartedAt: null,
      });
    else {
      const stage = entries.get(id)?.status;
      const reason = error instanceof Error ? error.message : "未知错误";
      const label =
        stage === "saving"
          ? "分析结果保存失败"
          : stage === "analyzing"
            ? "模型分析失败"
            : "媒体读取失败";
      update(id, {
        status: "failed",
        error: `${label}：${reason.slice(0, 2048)}`,
      });
      console.error("Media analysis range failed:", error);
      trim();
    }
  }

  function schedule() {
    if (!started || closed || running) return;
    const background = readBackground();
    if (!background) return;
    admit();
    const entry = [...entries.values()].find(
      (item) => item.status === "queued",
    );
    if (!entry) return;
    const { id } = entry;
    for (const admission of admitted.values()) {
      if (admission.pendingId !== id) continue;
      admission.through = entry.endedAt;
      admission.pendingId = undefined;
    }
    running = runRange(id, background).finally(() => {
      running = undefined;
      schedule();
    });
  }

  function reset() {
    generation++;
    controller?.abort(new AppError("request_cancelled"));
    controller = undefined;
    clearTimeout(expiryTimer);
    admitted.clear();
    entries.clear();
    currentMedia = undefined;
    for (const callbacks of listeners.values())
      for (const listener of callbacks) listener();
  }

  const close = memoize(async () => {
    closed = true;
    clearTimeout(expiryTimer);
    controller?.abort(new AppError("request_cancelled"));
    await running;
    currentMedia = undefined;
    for (const callbacks of listeners.values())
      for (const listener of callbacks) listener();
  });

  function detail(id: string) {
    const entry = entries.get(id);
    if (!entry) throw new AppError("not_found");
    return { ...entry };
  }

  async function watch(
    signal: AbortSignal,
    receive: (
      value: ReturnType<typeof snapshot> | ReturnType<typeof detail>,
    ) => Promise<void>,
    id?: string,
  ) {
    const key = id ?? "*";
    const callbacks = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, callbacks);
    let wake = Promise.withResolvers<void>();
    let dirty = true;
    const notify = () => {
      dirty = true;
      wake.resolve();
    };
    callbacks.add(notify);
    const stopping = addAbortListener(signal, () => wake.resolve());
    try {
      while (!signal.aborted) {
        if (closed) break;
        if (!dirty) await wake.promise;
        signal.throwIfAborted();
        wake = Promise.withResolvers<void>();
        dirty = false;
        const value = id ? detail(id) : snapshot();
        await receive(value);
        if (
          id &&
          "status" in value &&
          ["completed", "failed", "expired"].includes(value.status)
        )
          return value;
        await delay(100, undefined, { signal });
      }
      return undefined;
    } finally {
      stopping[Symbol.dispose]();
      callbacks.delete(notify);
      if (!callbacks.size) listeners.delete(key);
    }
  }

  return {
    snapshot,
    detail,
    watch,
    media(id: string, index: number) {
      const block =
        currentMedia?.id === id ? currentMedia.blocks[index] : undefined;
      if (!block) throw new AppError("not_found");
      return {
        data: block.media.data,
        contentType: block.media.kind === "video" ? "video/mp4" : "audio/mp4",
      };
    },
    start() {
      if (closed) throw new AppError("request_cancelled");
      started = true;
      admit();
      schedule();
    },
    notify() {
      if (!started || closed) return;
      admit();
      schedule();
    },
    reset,
    close,
  };
}
