import { StreamingAnswer } from "../../components/agent/StreamingAnswer";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom, useAtomValue } from "jotai";
import { AlertDialog } from "radix-ui";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, LoaderCircle, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import {
  listenForImageDrop,
  imageUploadTypes,
} from "../../modules/media/images";
import { Notice, StatusNotice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { RequestError } from "../../api/errors";
import {
  readPlanningImage,
  runSpatialPlanning,
  closeSpatialPlanning,
  planningImageLimit as imageLimit,
} from "../../modules/spatial/planning";
import {
  applySpatialLayout,
  type SpatialSnapshot,
} from "../../modules/spatial/api";
import {
  compareLayout,
  describeLayoutChange,
  layoutVersions,
  sameLayoutVersions,
  snapshotLayout,
} from "../../modules/spatial/layout";
import { MarkdownAnswer } from "../../components/agent/MarkdownAnswer";
import { Composer } from "./planning/Composer";
import { DraftPanel, FinalizeDialog } from "./planning/DraftPanel";
import {
  ImageThumbnail,
  ImageViewer,
  type PlanningImage,
} from "./planning/ImageViewer";
import { planningStateAtom, type Round, type Session } from "./planning/state";

const planningToolLabels = {
  update_spatial_draft: "更新空间和通道",
  update_spatial_questions: "整理待确认问题",
};

const stopped = "本轮分析已停止，图片和说明已放回输入框，可调整后重新发送。";

export function SpatialPlanning({
  scope,
  snapshot,
  available,
}: {
  scope: string;
  snapshot: SpatialSnapshot;
  available: boolean;
}) {
  const client = useQueryClient();
  const state = useAtomValue(planningStateAtom);
  const [text, setText] = useAtom(state.text);
  const [images, setImages] = useAtom(state.images);
  const [rounds, setRounds] = useAtom(state.rounds);
  const [session, setSession] = useAtom(state.session);
  // The saved layout the session was planned from; finalizing requires it to
  // still be current.
  const [base, setBase] = useAtom(state.base);
  const [busy, setBusy] = useAtom(state.busy);
  const [reading, setReading] = useAtom(state.reading);
  const [error, setError] = useAtom(state.error);
  const [notice, setNotice] = useAtom(state.notice);
  const [expanded, setExpanded] = useAtom(state.expanded);
  const [restarting, setRestarting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const saveKey = ["spatial-planning-save", scope];
  const saving = useIsMutating({ mutationKey: saveKey }) > 0;
  const [viewing, setViewing] = useState<{
    images: PlanningImage[];
    id: string;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null);
  const { pending, sessionId } = state;
  const thread = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const planningMessage = useMutation({
    mutationFn: ({
      input,
      signal,
      receive,
    }: {
      input: Parameters<typeof runSpatialPlanning>[1];
      signal: AbortSignal;
      receive: Parameters<typeof runSpatialPlanning>[3];
    }) => runSpatialPlanning(scope, input, signal, receive),
    networkMode: "always",
    gcTime: 0,
    // Busy requests have not been admitted, so retrying cannot duplicate a turn.
    retry: (failureCount, cause) =>
      failureCount < 6 &&
      !!pending.current &&
      !pending.current.signal.aborted &&
      cause instanceof RequestError &&
      cause.details.code === "workflow_busy",
    retryDelay: (attempt) => Math.min(250 * 2 ** attempt, 1000),
  });

  useEffect(() => {
    if (!available) pending.current?.abort();
  }, [available, pending]);

  const disabled = busy || reading || saving || !available;

  const dropFiles = useEffectEvent((files: File[]) => add(files));
  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    return listenForImageDrop(element, dropFiles, setDragging);
  }, []);

  // Follow growing content until the user scrolls up, then align the completed
  // answer's start so the reply is read from the top.
  const latest = rounds.at(-1);
  const latestId = latest?.id;
  const answered = !!latest?.outcome;
  useLayoutEffect(() => {
    const element = thread.current;
    if (!element || !latestId) return undefined;
    const target = element.querySelector<HTMLElement>(
      `[data-round="${latestId}"]`,
    );
    if (!target) return undefined;
    if (answered) {
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      target.scrollIntoView({ behavior, block: "start" });
      return undefined;
    }
    let following = true;
    let previousTop = element.scrollTop;
    const trackScroll = () => {
      const top = element.scrollTop;
      if (element.scrollHeight - top - element.clientHeight <= 1)
        following = true;
      else if (top < previousTop) following = false;
      previousTop = top;
    };
    const follow = () => {
      if (!following) return;
      element.scrollTop = element.scrollHeight;
      previousTop = element.scrollTop;
    };
    follow();
    element.addEventListener("scroll", trackScroll);
    // Observe rendered sizes, including deferred Markdown and viewport changes.
    const observer = new ResizeObserver(follow);
    observer.observe(target);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", trackScroll);
    };
  }, [latestId, answered]);

  function add(files: File[]) {
    if (disabled || !files.length) return;
    const supported = files.filter((file) =>
      imageUploadTypes.some((type) => type === file.type),
    );
    const unsupported =
      supported.length < files.length ? "已跳过不支持的文件。" : "";
    setError("");
    setNotice(unsupported);
    if (!supported.length) return;
    setReading(true);
    Promise.all(supported.map(readPlanningImage))
      .then((read) => {
        // Skip images already attached or sent earlier in this session.
        const seen = new Set(
          [...images, ...rounds.flatMap((round) => round.images)].map(
            (image) => image.image.data,
          ),
        );
        const fresh = read.filter((image) => {
          if (seen.has(image.image.data)) return false;
          seen.add(image.image.data);
          return true;
        });
        const accepted = fresh.slice(
          0,
          Math.max(0, imageLimit - images.length),
        );
        setImages((current) => [
          ...current,
          ...accepted.map((image) => ({ ...image, id: crypto.randomUUID() })),
        ]);
        setNotice(
          [
            unsupported,
            read.length > fresh.length
              ? `已跳过 ${read.length - fresh.length} 张重复图片。`
              : "",
            fresh.length > accepted.length
              ? `每轮最多 ${imageLimit} 张，多出的图片未添加。`
              : "",
          ].join(""),
        );
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "图片读取失败。");
      })
      .finally(() => {
        setReading(false);
      });
  }

  async function send() {
    if (pending.current || disabled) return;
    const round: Round = {
      id: crypto.randomUUID(),
      images,
      text: text.trim(),
      startedAt: Date.now(),
      progress: null,
      outcome: null,
    };
    if (!round.images.length && !round.text) return;
    const controller = new AbortController();
    pending.current = controller;
    setRounds((current) => [...current, round]);
    setText("");
    setImages([]);
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const planned = snapshot;
      const previous = session?.draft ?? snapshotLayout(planned);
      const next = await planningMessage.mutateAsync({
        input: {
          action: "message",
          ...(session
            ? { session_id: session.session_id }
            : { draft: previous }),
          text: round.text,
          images: round.images.map((image) => image.image),
        },
        signal: controller.signal,
        receive: (progress) => {
          controller.signal.throwIfAborted();
          setRounds((all) =>
            all.map((item) =>
              item.id === round.id ? { ...item, progress } : item,
            ),
          );
        },
      });
      controller.signal.throwIfAborted();
      sessionId.current = next.session_id;
      if (!session) setBase(planned);
      setSession(next);
      setRounds((all) =>
        all.map((item) =>
          item.id === round.id
            ? {
                ...item,
                progress: null,
                outcome: {
                  reply: item.progress?.reply,
                  questions: next.questions,
                  change: describeLayoutChange(previous, next.draft),
                },
              }
            : item,
        ),
      );
    } catch (cause) {
      // Put the unanswered round back into the composer.
      setRounds((all) => all.filter((item) => item.id !== round.id));
      setImages(round.images);
      setText(round.text);
      if (controller.signal.aborted) setNotice(stopped);
      else if (
        cause instanceof RequestError &&
        cause.details.code === "not_found"
      ) {
        sessionId.current = null;
        setSession(null);
        setBase(null);
        setRounds([]);
        setError("会话已失效，请重新开始分析。你的本轮输入已保留。");
      } else setError(requestErrorMessage(cause));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function endSession(id = sessionId.current) {
    if (id !== sessionId.current) return;
    pending.current?.abort();
    sessionId.current = null;
    setSession(null);
    setBase(null);
    setExpanded(false);
    if (id)
      closeSpatialPlanning(scope, id).catch((cause: unknown) => {
        console.error("Spatial planning session close failed", cause);
      });
  }

  const finalize = useMutation({
    mutationKey: saveKey,
    mutationFn: ({
      draft,
      planned,
    }: {
      id: string;
      draft: Session["draft"];
      planned: SpatialSnapshot;
    }) =>
      applySpatialLayout(client, scope, {
        expected: layoutVersions(planned),
        ...draft,
      }),
    onSuccess: (_next, { id }) => {
      if (sessionId.current !== id) return;
      setFinalizing(false);
      restart(id);
    },
    onError: (cause, { id }) => {
      if (sessionId.current === id) setError(requestErrorMessage(cause));
    },
  });

  function restart(id = sessionId.current) {
    endSession(id);
    setRestarting(false);
    finalize.reset();
    setRounds([]);
    setImages([]);
    setText("");
    setError("");
    setNotice("");
  }

  const visibleDraft =
    (busy ? latest?.progress?.draft : undefined) ?? session?.draft;
  const comparison = useMemo(
    () => (visibleDraft ? compareLayout(snapshot, visibleDraft) : null),
    [snapshot, visibleDraft],
  );
  const stale = !!base && !sameLayoutVersions(base, snapshot);
  const blocker = stale
    ? "空间资料在规划期间被修改过，这份草稿不能直接保存。请重新开始，基于最新资料规划。"
    : comparison?.referenced.length
      ? `草稿删除的空间或通道仍有 ${comparison.referenced.length} 条观测绑定，请先在手动设置中解除。`
      : null;
  const stage = session || rounds.length ? "planning" : "intro";
  return (
    <section
      ref={root}
      className="relative mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-3 pt-2"
      aria-label="AI 空间规划"
    >
      {!available ? (
        <Notice className="mb-0">家庭连接就绪后可使用 AI 空间规划。</Notice>
      ) : null}
      {comparison ? (
        <DraftPanel
          comparison={comparison}
          expanded={expanded}
          running={busy || session?.status === "running"}
          blocker={blocker}
          disabled={busy || saving}
          onToggle={() => setExpanded((open) => !open)}
          onRestart={() => setRestarting(true)}
          onFinalize={() => {
            finalize.reset();
            setFinalizing(true);
          }}
        />
      ) : null}
      <div ref={thread} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {stage === "intro" ? (
          <Intro
            disabled={disabled}
            reading={reading}
            hasImages={images.length > 0}
            onPick={() => picker.current?.click()}
          />
        ) : (
          <ol className="grid gap-6 pb-4 pt-2">
            {rounds.map((round, index) => (
              <RoundView
                key={round.id}
                round={round}
                latest={index === rounds.length - 1}
                busy={busy}
                viewing={viewing?.id ?? null}
                onView={(id) => setViewing({ images: round.images, id })}
                onStop={() => pending.current?.abort()}
                onShowDraft={() => setExpanded(true)}
              />
            ))}
          </ol>
        )}
      </div>
      <output className="sr-only">
        {latest?.outcome
          ? `AI 已回复${latest.outcome.change ? `，草稿${latest.outcome.change}` : ""}`
          : ""}
      </output>
      {notice ? (
        <StatusNotice className="mb-0 shrink-0 py-3">{notice}</StatusNotice>
      ) : null}
      {error ? (
        <Notice tone="error" className="mb-0 shrink-0 py-3">
          {error}
        </Notice>
      ) : null}
      <Composer
        started={!!session}
        images={images}
        text={text}
        disabled={disabled}
        reading={reading}
        sending={busy}
        viewing={viewing?.id ?? null}
        picker={picker}
        onText={setText}
        onAdd={add}
        onRemove={(id) =>
          setImages((current) => current.filter((image) => image.id !== id))
        }
        onView={(id) => setViewing({ images, id })}
        onSend={() => {
          send().catch((cause: unknown) => {
            setError(requestErrorMessage(cause));
          });
        }}
        onStop={() => pending.current?.abort()}
      />
      {dragging && !disabled ? (
        <div
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-ink bg-paper/85 text-sm font-medium"
          aria-hidden="true"
        >
          松开以添加户型图
        </div>
      ) : null}
      <ImageViewer
        images={viewing?.images ?? []}
        current={viewing?.id ?? null}
        onSelect={(id) =>
          setViewing((current) => (current ? { ...current, id } : current))
        }
        onClose={() => setViewing(null)}
      />
      {comparison ? (
        <FinalizeDialog
          open={finalizing}
          comparison={comparison}
          pending={saving}
          error={finalize.error ? requestErrorMessage(finalize.error) : ""}
          onCancel={() => setFinalizing(false)}
          onConfirm={() => {
            if (!session || !base || saving) return;
            setError("");
            finalize.mutate({
              id: session.session_id,
              draft: session.draft,
              planned: base,
            });
          }}
        />
      ) : null}
      <AlertDialog.Root
        open={restarting}
        onOpenChange={(open) => {
          if (!open) setRestarting(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-ink/25" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-7 shadow-xl">
            <AlertDialog.Title className="text-xl font-medium">
              放弃当前草稿？
            </AlertDialog.Title>
            <AlertDialog.Description className="mb-6 mt-3 text-sm leading-7 text-muted">
              将结束这次 AI 规划，未保存的草稿和对话不会保留。
            </AlertDialog.Description>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>继续调整</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (!saving) restart();
                  }}
                >
                  重新开始
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

function Intro({
  disabled,
  reading,
  hasImages,
  onPick,
}: {
  disabled: boolean;
  reading: boolean;
  hasImages: boolean;
  onPick: () => void;
}) {
  return (
    <div className="mx-auto grid min-h-full w-full max-w-sm content-center gap-5 py-6 text-center">
      <h2 className="text-base font-medium text-ink">
        上传户型图，让 AI 整理空间和通道
      </h2>
      {hasImages ? null : (
        <button
          type="button"
          disabled={disabled}
          onClick={onPick}
          className="flex min-h-56 flex-col items-center justify-center gap-5 rounded-2xl border border-line bg-white p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink enabled:hover:bg-surface/50 disabled:cursor-default disabled:opacity-60"
        >
          <span
            className="grid size-24 place-items-center rounded-2xl bg-surface text-ink"
            aria-hidden="true"
          >
            {reading ? (
              <LoaderCircle
                size={36}
                strokeWidth={1.5}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Plus size={48} strokeWidth={1.25} />
            )}
          </span>
          <span className="grid gap-1">
            <span className="text-sm font-medium text-ink">
              {reading ? "正在读取图片…" : "点击或拖入户型图"}
            </span>
            <span className="text-xs text-muted">
              JPEG、PNG、WebP，每轮最多 {imageLimit} 张
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function RoundView({
  round,
  latest,
  busy,
  viewing,
  onView,
  onStop,
  onShowDraft,
}: {
  round: Round;
  latest: boolean;
  busy: boolean;
  viewing: string | null;
  onView: (id: string) => void;
  onStop: () => void;
  onShowDraft: () => void;
}) {
  const { outcome } = round;
  return (
    <li data-round={round.id} className="grid scroll-mt-2 gap-3">
      <div className="grid justify-items-end gap-2">
        {round.images.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {round.images.map((image) => (
              <ImageThumbnail
                key={image.id}
                image={image}
                open={viewing === image.id}
                label={`放大查看 ${image.name}`}
                onOpen={() => onView(image.id)}
                className="size-20"
              />
            ))}
          </div>
        ) : null}
        {round.text ? (
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-surface px-4 py-2.5 text-sm leading-6">
            {round.text}
          </p>
        ) : null}
      </div>
      {outcome ? (
        <div className="grid gap-3">
          {outcome.reply ? (
            <MarkdownAnswer>{outcome.reply}</MarkdownAnswer>
          ) : null}
          {outcome.questions.length ? (
            <div
              className={`rounded-xl px-4 py-3 ${latest ? "bg-warning/7" : "bg-surface"}`}
            >
              <h3
                className={`text-xs font-medium ${latest ? "text-warning" : "text-muted"}`}
              >
                {latest ? "需要你确认 · 在下方回复即可" : "AI 当时的问题"}
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-6">
                {outcome.questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {outcome.change ? (
            <p className="flex items-start gap-1.5 text-xs leading-5 text-muted">
              <Check
                size={14}
                className="mt-0.5 shrink-0 text-sage"
                aria-hidden="true"
              />
              <span>
                草稿：{outcome.change}
                {latest ? (
                  <button
                    type="button"
                    onClick={onShowDraft}
                    className="ml-2 rounded text-ink underline underline-offset-4 decoration-ink/30 hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  >
                    查看
                  </button>
                ) : null}
              </span>
            </p>
          ) : null}
        </div>
      ) : busy ? (
        <StreamingAnswer
          progress={round.progress}
          startedAt={round.startedAt}
          onStop={onStop}
          pendingLabel="AI 识别空间与通道"
          toolLabels={planningToolLabels}
        >
          {round.progress ? (
            <p className="text-xs text-muted" aria-live="polite">
              草稿：{round.progress.draft.spaces.length} 个空间 ·{" "}
              {round.progress.draft.passages.length} 条通道
            </p>
          ) : null}
        </StreamingAnswer>
      ) : null}
    </li>
  );
}
