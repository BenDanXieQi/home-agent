import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  mediaAnalysisEntrySchema,
  mediaAnalysisCompletedSchema,
  createMediaAnalysisSession,
  mediaAgentHistoryPageSchema,
  mediaAnalysisRecordingSchema,
  mediaAnalysisSummaryKind,
} from "./session";
import type { z } from "zod";
import { attemptAsync, memoize } from "es-toolkit";
import { AsyncQueuer } from "@tanstack/pacer/async-queuer";
import type { agentContextDataSchemas } from "@home-agent/api/agent-context";
import { AppError } from "@home-agent/api/errors";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createAgentDeviceMetadata } from "../context/devices";
import type { createContextReceiver } from "../context/receiver";
import { observationBinding, observationTarget } from "../context/spatial";
import { formatMediaTime, type MediaAnalysisInput } from "./analysis";
import type {
  createMediaAnalysisExtension,
  mediaAnalysisTaskInputSchema,
  readCameraMediaSchema,
} from "./extension";
import type { conversationProgressSchema } from "../conversation/contracts";

export function createMediaAnalysisAgent({
  readParts,
  harness,
  model,
  extension,
  analyze,
  readMedia,
  readCameraMedia,
  saveCompleted,
}: {
  readParts: ReturnType<typeof createContextReceiver>["currentParts"];
  saveCompleted: (
    entry: z.infer<typeof mediaAnalysisCompletedSchema>,
    signal: AbortSignal,
  ) => Promise<void>;
  harness: Parameters<typeof createMediaAnalysisSession>[0]["harness"];
  model: Parameters<typeof createMediaAnalysisSession>[0]["model"];
  extension: Parameters<typeof createMediaAnalysisSession>[0]["extension"];
  analyze: ReturnType<typeof createMediaAnalysisExtension>["analyze"];
  readMedia: (
    range: z.infer<typeof mediaAnalysisEntrySchema>,
    signal: AbortSignal,
  ) => Promise<MediaAnalysisInput["content"]>;
  readCameraMedia: (
    input: z.infer<typeof readCameraMediaSchema>,
    signal: AbortSignal,
  ) => Promise<{
    content: MediaAnalysisInput["content"];
    startedAt: number;
    endedAt: number;
    includeAudio: boolean;
  }>;
}) {
  const admitted = new Map<
    string,
    Pick<
      z.infer<typeof mediaAnalysisEntrySchema>,
      | "id"
      | "source"
      | "kind"
      | "includeAudio"
      | "startedAt"
      | "endedAt"
      | "readableUntil"
    >
  >();
  const entries = new Map<string, z.infer<typeof mediaAnalysisEntrySchema>>();
  let history: z.infer<typeof mediaAgentHistoryPageSchema> = {
    entries: [],
    nextCursor: null,
  };
  const listeners = new Map<string, Set<() => void>>();
  const mediaInputs = new Map<
    string,
    Extract<MediaAnalysisInput["content"][number], { type: "media" }>[]
  >();

  function publish(id: string, list = true) {
    for (const listener of listeners.get(id) ?? []) listener();
    if (list) for (const listener of listeners.get("*") ?? []) listener();
  }

  function snapshot() {
    const background = readBackground();
    const now = Date.now();
    const targets =
      background?.spatial.observation_bindings.flatMap((binding) => {
        if (!binding.enabled || binding.channel === null) return [];

        const target = observationTarget(
          background.spatial,
          { deviceId: binding.device_id, channel: binding.channel },
          now,
        );
        return target ? [{ id: target.id, name: target.name }] : [];
      }) ?? [];
    return {
      enabled: true,
      history,
      observationTargets: [
        ...new Map(targets.map((target) => [target.id, target])).values(),
      ],
      entries: [...entries.values()].map(
        ({ reply, reasoning: _reasoning, media: _media, ...entry }) => {
          const target =
            background &&
            observationTarget(
              background.spatial,
              entry.source,
              entry.startedAt,
            );
          return {
            ...entry,
            summary: reply.slice(0, 240),
            observationTarget: target
              ? { id: target.id, name: target.name }
              : null,
          };
        },
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
      ["completed", "failed", "expired", "skipped"].includes(entry.status),
    );
    for (const entry of settled.slice(0, Math.max(0, settled.length - 30))) {
      entries.delete(entry.id);
      mediaInputs.delete(entry.id);
    }
  }
  let started = false;
  let closed = false;
  const lifecycle = new AbortController();
  let rangeRequests = new AbortController();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const session = createMediaAnalysisSession({
    harness,
    model,
    extension,
    onHistory(value) {
      history = value;
      publish("*", false);
    },
  });
  const concurrency = 5;
  const queue = new AsyncQueuer(runRange, {
    concurrency,
    maxSize: 0,
    started: false,
    asyncRetryerOptions: { maxAttempts: 1 },
    getIsExpired: (id) => {
      const entry = entries.get(id);
      return (
        !entry || entry.status !== "queued" || Date.now() >= entry.readableUntil
      );
    },
    onExpire: (id) => {
      if (entries.get(id)?.status === "queued") expire(id);
    },
    onReject: (id, queuer) => {
      update(id, {
        status: "skipped",
        error: `待分析区间超过 ${queuer.options.maxSize} 个，已优先保留较新的媒体，本区间已跳过`,
      });
    },
    onError: analysisFailed,
    onSettled: (id, queuer) => {
      if (mediaInputs.has(id)) {
        const activeItems = queuer.peekActiveItems();

        for (const mediaId of mediaInputs.keys()) {
          const status = entries.get(mediaId)?.status;
          if (
            mediaId !== id &&
            !activeItems.includes(mediaId) &&
            (status === "completed" || status === "failed")
          )
            mediaInputs.delete(mediaId);
        }
      }
      if (!readBackground()) queuer.stop();
    },
  });

  function expire(id: string) {
    update(id, { status: "expired", error: "媒体已过期，未进行分析" });
  }

  function admit() {
    const now = Date.now();
    for (const entry of entries.values()) {
      if (
        ["collecting", "queued"].includes(entry.status) &&
        now >= entry.readableUntil
      )
        expire(entry.id);
    }

    const observations = readParts()?.observations;
    const ranges: z.infer<
      typeof agentContextDataSchemas.observations
    >["media_ranges"] =
      observations?.status === "ready" ? observations.data.media_ranges : [];
    for (const {
      id: _rangeId,
      ready,
      settledAt: _settledAt,
      ...range
    } of ranges) {
      if (range.kind === "audio" || now >= range.readableUntil) continue;
      const covered = [...admitted.values()]
        .filter(
          (entry) =>
            entry.source.deviceId === range.source.deviceId &&
            entry.source.channel === range.source.channel &&
            entry.kind === range.kind &&
            entry.includeAudio === range.includeAudio &&
            entry.startedAt < range.endedAt &&
            entry.endedAt > range.startedAt,
        )
        .toSorted((a, b) => a.startedAt - b.startedAt);
      const status = ready ? ("queued" as const) : ("collecting" as const);
      function enqueue(startedAt: number, endedAt: number) {
        const background = readBackground();
        const camera = createAgentDeviceMetadata(background?.household).device({
          device_id: range.source.deviceId,
        });
        const target =
          background &&
          observationTarget(background.spatial, range.source, startedAt);
        const id = crypto.randomUUID();
        entries.set(id, {
          ...range,
          id,
          startedAt,
          endedAt,
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
        admitted.set(id, {
          id,
          source: range.source,
          kind: range.kind,
          includeAudio: range.includeAudio,
          startedAt,
          endedAt,
          readableUntil: range.readableUntil,
        });
        publish(id);
      }

      // Window IDs change as old windows leave a range; track accepted time instead.
      let through = range.startedAt;
      for (const [index, entry] of covered.entries()) {
        entry.readableUntil = Math.max(
          entry.readableUntil,
          range.readableUntil,
        );
        if (entry.startedAt > through) enqueue(through, entry.startedAt);
        const pending = entries.get(entry.id);
        if (pending && ["collecting", "queued"].includes(pending.status)) {
          const patch = {
            ...range,
            startedAt: Math.max(entry.startedAt, range.startedAt),
            endedAt: Math.min(
              range.endedAt,
              covered[index + 1]?.startedAt ?? range.endedAt,
            ),
            status,
          };
          Object.assign(entry, patch);
          update(entry.id, patch);
        }
        through = Math.max(through, entry.endedAt);
      }
      if (through < range.endedAt) enqueue(through, range.endedAt);
    }

    // A range's earliest deadline must not discard coverage of its readable tail.
    if (observations?.status === "ready")
      for (const [id, entry] of admitted) {
        if (now >= entry.readableUntil) admitted.delete(id);
      }

    trim();
    clearTimeout(expiryTimer);
    const deadlines = [...entries.values()]
      .filter((entry) => ["collecting", "queued"].includes(entry.status))
      .map((entry) => entry.readableUntil);
    if (deadlines.length)
      expiryTimer = setTimeout(
        () => {
          admit();
          schedule();
        },
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

  async function readInput(
    input: z.infer<typeof mediaAnalysisTaskInputSchema>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const background = readBackground();
    if (!background) throw new AppError("household_unavailable");
    const { members, spatial, household } = background;
    const mediaInput =
      input.kind === "initial"
        ? {
            content: await readMedia(input.range, signal),
            startedAt: input.range.startedAt,
            endedAt: input.range.endedAt,
            includeAudio: input.range.includeAudio,
          }
        : await readCameraMedia(input.request, signal);
    signal.throwIfAborted();
    const range = {
      source:
        input.kind === "initial" ? input.range.source : input.request.source,
      startedAt: mediaInput.startedAt,
      endedAt: mediaInput.endedAt,
    };
    const media = mediaInput.content;
    const blocks = media.filter((block) => block.type === "media");
    if (input.kind === "initial") {
      mediaInputs.set(input.range.id, blocks);
      update(input.range.id, {
        status: "analyzing",
        media: blocks.map((block, index) => ({
          index,
          kind: block.media.kind,
          contentType:
            block.media.kind === "video" ? "video/mp4" : "audio/mpeg",
        })),
      });
    }

    const devices = createAgentDeviceMetadata(household);
    const spaceName = (spaceId: string) =>
      spatial.spaces.find((space) => space.id === spaceId)?.name ?? "未知空间";
    const source = range.source;
    const at = range.startedAt;
    const camera = devices.device({ device_id: source.deviceId });
    const binding = observationBinding(spatial, source, at);
    const target = observationTarget(spatial, source, at);
    if (input.kind === "initial")
      update(input.range.id, {
        deviceName: camera.device_name ?? "摄像头",
        location: target?.name ?? camera.room_name ?? "未知位置",
      });
    const content: MediaAnalysisInput["content"] = [
      {
        type: "text",
        text: [
          "时间约定：以下日期和时刻均按服务运行环境的本地时区标注，包含 GMT 偏移；描述事件时使用所标注的时区。",
          `本次实际输入：${blocks.some((block) => block.media.kind === "video") ? "包含视频画面" : "未提供画面"}；实际时间和音轨状态见媒体说明。`,
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
    return {
      content,
      recording: {
        id: input.kind === "initial" ? input.range.id : crypto.randomUUID(),
        ...range,
        kind: input.kind === "initial" ? input.range.kind : "video",
        includeAudio: mediaInput.includeAudio,
        deviceName: camera.device_name ?? "摄像头",
        location: target?.name ?? camera.room_name ?? "未知位置",
        observationTarget: target ? { id: target.id, name: target.name } : null,
        question: input.kind === "initial" ? null : input.request.question,
      } satisfies Omit<
        z.infer<typeof mediaAnalysisRecordingSchema>,
        "reply" | "reasoning" | "analysisStartedAt" | "completedAt"
      >,
    };
  }

  async function onProgress(
    input: z.infer<typeof mediaAnalysisTaskInputSchema>,
    progress: z.infer<typeof conversationProgressSchema>,
    reasoning: string,
  ) {
    if (input.kind === "initial")
      update(input.range.id, { reply: progress.reply, reasoning }, false);
  }

  async function analyzeRange(id: string, signal: AbortSignal) {
    const conversation = await session.current(signal);
    signal.throwIfAborted();
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const recording = await analyze(
      { kind: "initial", range: detail(id) },
      signal,
    );
    const { reply } = recording;
    const completed = mediaAnalysisCompletedSchema.parse({
      ...entries.get(id),
      ...recording,
      status: "completed",
    });
    update(id, { ...completed, status: "saving" });
    signal.throwIfAborted();
    const results = await Promise.allSettled([
      conversation.submit(
        {
          type: "input",
          whenBusy: "followUp",
          requestId: `media-summary:${id}`,
          entry: {
            kind: mediaAnalysisSummaryKind,
            data: recording,
          },
          content: [
            `摄像头：${completed.deviceName}；镜头来源：${JSON.stringify(completed.source)}；位置：${completed.location}；时间：${formatMediaTime(completed.startedAt)} 至 ${formatMediaTime(completed.endedAt)}。`,
            reply,
          ].join("\n"),
        },
        context,
      ),
      saveCompleted(completed, signal),
    ]);
    const errors = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const reason =
        result.reason instanceof Error ? result.reason.message : "未知错误";
      return [
        `${index === 0 ? "概述提交失败" : "分析结果保存失败"}：${reason.slice(0, 2048)}`,
      ];
    });
    update(id, {
      ...completed,
      error: errors.length ? errors.join("\n") : null,
    });
    trim();
  }

  async function runRange(id: string) {
    if (entries.get(id)?.status !== "queued" || !readBackground()) return;

    update(id, {
      status: "preparing",
      analysisStartedAt: Date.now(),
      error: null,
      reply: "",
      reasoning: "",
      media: [],
    });
    const requestSignal = AbortSignal.any([
      lifecycle.signal,
      rangeRequests.signal,
      AbortSignal.timeout(120_000),
    ]);
    const [error] = await attemptAsync(() => analyzeRange(id, requestSignal));
    if (error)
      throw new Error(error instanceof Error ? error.message : "未知错误", {
        cause: error,
      });
  }

  function analysisFailed(error: Error, id: string) {
    if (closed) return;

    const stage = entries.get(id)?.status;
    if (stage === "completed") return;
    if (stage === "saving") {
      const entry = detail(id);
      update(id, {
        status: "completed",
        completedAt: entry.completedAt ?? Date.now(),
        error: "概述提交失败：分析请求已取消\n分析结果保存失败：分析请求已取消",
      });
      trim();
    } else {
      const label = stage === "analyzing" ? "模型分析失败" : "媒体读取失败";
      update(id, {
        status: "failed",
        error: `${label}：${error.message.slice(0, 2048)}`,
      });
      console.error("Media analysis range failed:", error);
      trim();
    }
  }

  function schedule() {
    if (!started || closed) return;

    queue.stop();
    const household = readParts()?.household;
    if (household?.status !== "ready") return;

    const cameraCount = Object.values(household.data.device).reduce(
      (total, device) =>
        total +
        (device.camera && !device.archived ? device.channels.length : 0),
      0,
    );
    queue.setOptions({ maxSize: cameraCount * 10 });
    queue.clear();
    // Rebuild only pending work: ranges can extend or arrive out of order.
    const pending = [...entries.values()]
      .filter((entry) => entry.status === "queued")
      .toSorted((a, b) => b.endedAt - a.endedAt || b.queuedAt - a.queuedAt);
    const ready = readBackground() !== undefined;
    for (const entry of pending) {
      if (Date.now() >= entry.readableUntil) {
        expire(entry.id);
        continue;
      }

      // Capacity counts waiting items; fill free execution slots before dropping any.
      if (
        ready &&
        queue.store.state.isFull &&
        queue.peekActiveItems().length < concurrency
      ) {
        queue.start();
        queue.stop();
      }
      queue.addItem(entry.id);
    }
    trim();
    if (ready) queue.start();
  }

  async function drain() {
    const drained = Promise.withResolvers<void>();
    const subscription = queue.store.subscribe(({ activeItems }) => {
      if (!activeItems.length) drained.resolve();
    });
    if (!queue.peekActiveItems().length) drained.resolve();

    try {
      await drained.promise;
    } finally {
      subscription.unsubscribe();
    }
  }

  const close = memoize(async () => {
    closed = true;
    clearTimeout(expiryTimer);
    queue.stop();
    queue.clear();
    lifecycle.abort(new AppError("request_cancelled"));
    const results = await Promise.allSettled([drain(), session.close()]);
    mediaInputs.clear();
    for (const callbacks of listeners.values())
      for (const listener of callbacks) listener();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Media Agent close failed");
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
          ["completed", "failed", "expired", "skipped"].includes(value.status)
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
    history(before: string | undefined, signal: AbortSignal) {
      return session.history(before, signal);
    },
    detail,
    watch,
    readInput,
    onProgress,
    media(id: string, index: number) {
      const block = mediaInputs.get(id)?.[index];
      if (!block) throw new AppError("not_found");
      return {
        data: block.media.data,
        contentType: block.media.kind === "video" ? "video/mp4" : "audio/mpeg",
      };
    },
    async start() {
      if (closed) throw new AppError("request_cancelled");
      await session.current(lifecycle.signal);
      started = true;
      admit();
      schedule();
    },
    notify() {
      if (!started || closed) return;
      admit();
      schedule();
      publish("*", false);
    },
    close,
    async reset() {
      clearTimeout(expiryTimer);
      queue.stop();
      queue.clear();
      rangeRequests.abort(new AppError("request_cancelled"));
      await drain();
      entries.clear();
      admitted.clear();
      mediaInputs.clear();
      rangeRequests = new AbortController();
      publish("*", false);
    },
  };
}
