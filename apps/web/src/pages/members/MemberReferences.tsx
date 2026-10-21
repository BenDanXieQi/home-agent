import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Camera, ImagePlus, Upload } from "lucide-react";
import type { z } from "zod";
import {
  identityCapacity,
  identityEnrollmentLimits,
  type referenceMemberSchema,
  type referencePreviewSchema,
} from "@home-agent/api/contracts";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { memberReadyAtom } from "../../modules/members/state";
import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { Member } from "../../modules/members/queries";
import {
  referenceListOptions,
  uploadReference,
  referencePreviewOptions,
  cancelReference,
  confirmReference,
  deleteReference,
  toggleIdentity,
} from "../../modules/members/identity";
import { ReferenceRecorder } from "./ReferenceRecorder";
import { ImageFileInput, ImageDropZone } from "../../components/ImageUpload";
import { imageUploadTypes } from "../../modules/media/images";

export function MemberReferences({
  member,
  scope,
}: {
  member: Member;
  scope: string;
}) {
  const person = member.kind === "person";
  const title = "成员识别参考";
  const input = { memberId: member.id, scope_epoch: scope };
  const ready = useAtomValue(memberReadyAtom);
  const references = useQuery(referenceListOptions(input));
  const [preview, setPreview] = useState<z.infer<
    typeof referencePreviewSchema
  > | null>(null);
  const [camera, setCamera] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operationLabel, setOperationLabel] = useState("");
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState<AbortController | null>(null);
  const uploading = upload !== null;
  const active = useRef(preview);
  function updatePreview(next: typeof preview) {
    active.current = next;
    setPreview(next);
  }
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      const current = active.current;
      if (current)
        cancelReference({
          memberId: member.id,
          scope_epoch: scope,
          sessionId: current.sessionId,
        }).catch((cause) =>
          console.warn("登记取消失败，服务器将在期限内释放", cause),
        );
    };
  }, [member.id, scope]);
  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => {
      await operation();
    },
    onMutate: () => {
      setError("");
    },
    onError: (cause) =>
      setError(
        cause instanceof RequestError
          ? requestErrorMessage(cause)
          : cause instanceof Error
            ? cause.message
            : "操作失败，请重试",
      ),
    onSettled: async () => {
      pending.current = false;
      await references.refetch();
    },
  });
  const busy = mutation.isPending || cameraBusy || !ready;
  const modelBlocked =
    !references.data ||
    references.data.model === "unconfigured" ||
    references.data.model === "unavailable";
  const full =
    (references.data?.samples.length ?? 0) >=
    identityCapacity.referencesPerMember;
  const outdated =
    references.data?.samples.filter((sample) => sample.outdated) ?? [];
  function perform(operation: () => Promise<unknown>, label: string) {
    if (pending.current || cameraBusy || !ready) return;
    pending.current = true;
    setNotice("");
    setOperationLabel(label);
    mutation.mutate(operation);
  }
  const uploadDisabled = busy || camera || !!preview || modelBlocked || full;

  function addPhotos(files: File[]) {
    if (uploadDisabled || !files.length) return;
    if (
      files.some((file) => !imageUploadTypes.some((type) => type === file.type))
    ) {
      setError("请选择 JPEG、PNG 或 WebP 图片。");
      return;
    }
    perform(async () => {
      const controller = new AbortController();
      const lifetimeSignal = lifetime.current?.signal;
      if (!lifetimeSignal) return;
      const signal = AbortSignal.any([controller.signal, lifetimeSignal]);
      setUpload(controller);

      try {
        const result = await uploadReference(input, files, signal);
        if (signal.aborted) {
          await cancelReference({ ...input, sessionId: result.sessionId });
          return;
        }
        updatePreview(result);
        setCamera(false);
      } catch (cause) {
        if (lifetimeSignal.aborted) return;
        if (
          !controller.signal.aborted ||
          !(
            cause === signal.reason ||
            (cause instanceof RequestError &&
              cause.details.code === "request_cancelled")
          )
        )
          throw cause;
        setNotice("已取消上传，没有保存新的参考照片。可以重新选择照片。");
      } finally {
        setUpload((current) => (current === controller ? null : current));
      }
    }, `正在分析 ${files.length} 张照片，完成后请选择并保存…`);
  }

  return (
    <ImageDropZone
      className="space-y-4 rounded-2xl bg-surface p-5"
      label={title}
      dropLabel="松开以添加参考照片"
      disabled={uploadDisabled}
      onFiles={addPhotos}
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="rounded-full bg-white px-3 py-1 text-xs tabular-nums text-muted">
            {references.data
              ? `${references.data.samples.length} / ${identityCapacity.referencesPerMember} 张`
              : "正在加载…"}
          </span>
        </div>
        <p className="text-xs leading-6 text-muted">
          {person
            ? `添加「${member.name}」的清晰单人照片，帮助识别摄像头中的人物。`
            : `上传「${member.name}」的清晰照片，用于识别摄像头中的这只宠物。`}
        </p>
      </header>
      {references.data?.samples.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4">
          <div className="space-y-1">
            <p className="text-sm">
              {references.data.enableReason || modelBlocked
                ? "成员识别暂不可用"
                : references.data.enabled
                  ? "成员识别已启用"
                  : "成员识别未启用"}
            </p>
            <p className="text-xs leading-6 text-muted">
              {references.data.enableReason ||
                "启用后，摄像头识别结果会自动保存到最近活动。"}
            </p>
          </div>
          <Button
            size="small"
            disabled={
              busy ||
              camera ||
              !!preview ||
              (!references.data.enabled && !!references.data.enableReason)
            }
            onClick={() => {
              const enabled = !references.data?.enabled;
              perform(
                () => toggleIdentity({ ...input, enabled }),
                enabled ? "正在启用成员识别…" : "正在停用成员识别…",
              );
            }}
          >
            {references.data.enabled ? "停用识别" : "启用识别"}
          </Button>
        </div>
      ) : null}
      {modelBlocked && references.data ? (
        <Notice tone="warning">
          {references.data.modelReason ??
            (references.data.model === "unconfigured"
              ? "尚未配置成员识别模型，请先在本机配置模型。"
              : "成员识别模型暂不可用，请检查模型配置后重试。")}
        </Notice>
      ) : null}
      {outdated.length > 0 ? (
        <Notice tone="warning">
          <div className="space-y-3">
            <p>
              {outdated.length} 张参考已失效，无法用于当前识别。先删除失效参考，
              再重新上传原照片或录制视频；其他参考会保留。
            </p>
            <Button
              size="small"
              variant="secondary"
              disabled={busy || camera || !!preview}
              onClick={() => {
                const signal = lifetime.current?.signal;
                perform(async () => {
                  for (const sample of outdated) {
                    signal?.throwIfAborted();
                    await deleteReference(input, sample.id);
                  }
                  signal?.throwIfAborted();
                  setNotice(
                    `已删除 ${outdated.length} 张失效参考，请重新登记照片。`,
                  );
                }, "正在删除失效参考…");
              }}
            >
              删除 {outdated.length} 张失效参考
            </Button>
          </div>
        </Notice>
      ) : null}
      {error || references.error ? (
        <Notice tone="error">
          {error || requestErrorMessage(references.error)}
        </Notice>
      ) : null}
      {mutation.isPending || notice ? (
        <Notice aria-live="polite">
          <strong>{mutation.isPending ? operationLabel : notice}</strong>
        </Notice>
      ) : null}
      {full ? (
        <Notice>参考照片已满，请先删除不需要的照片再补充。</Notice>
      ) : null}
      {!camera && !preview ? (
        <div className="space-y-4 rounded-xl border border-line bg-white p-4 sm:p-5">
          {references.data?.samples.length === 0 ? (
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-muted">
                <ImagePlus size={20} aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-medium">还没有参考照片</h3>
                <p className="text-xs leading-6 text-muted">
                  {person
                    ? "用家庭摄像头录制一段视频，或上传已有照片。挑选后确认保存。"
                    : "上传只包含这只宠物的清晰照片，挑选后保存。"}
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {person ? (
              <Button
                variant="primary"
                icon={<Camera size={16} aria-hidden="true" />}
                disabled={busy || camera || !!preview || modelBlocked || full}
                onClick={() => {
                  setCamera(true);
                  setNotice("");
                  setError("");
                }}
              >
                从摄像头录制
              </Button>
            ) : null}
            <Button
              variant="secondary"
              icon={<Upload size={16} aria-hidden="true" />}
              className="border-line bg-white"
              disabled={!uploading && uploadDisabled}
              status={uploading ? "pending" : "idle"}
              pendingAction={{
                label: "取消上传",
                onClick: () => {
                  upload?.abort();
                  setOperationLabel("正在取消，等待当前处理和清理完成…");
                },
              }}
              onClick={() => fileInput.current?.click()}
            >
              上传照片（可多选）
            </Button>
          </div>
          <p className="text-xs leading-6 text-muted">
            支持多选或拖入 JPEG、PNG、WebP 图片，每批最多{" "}
            {identityEnrollmentLimits.candidates} 张，总大小不超过 32 MiB。
          </p>
        </div>
      ) : null}
      <ImageFileInput
        ref={fileInput}
        label={person ? "上传单人参考照片" : "上传宠物参考照片"}
        disabled={uploadDisabled}
        onFiles={addPhotos}
      />
      {person && camera && !preview ? (
        <ReferenceRecorder
          input={input}
          disabled={mutation.isPending || !ready || modelBlocked || full}
          onBusyChange={setCameraBusy}
          onCancel={() => {
            setCamera(false);
            setNotice("");
            setError("");
          }}
          onPreview={(next) => {
            setCameraBusy(false);
            setNotice("");
            updatePreview(next);
            setCamera(false);
          }}
        />
      ) : null}
      {preview ? (
        <ReferencePreview
          key={preview.sessionId}
          initial={preview}
          input={input}
          busy={busy}
          confirm={(candidateIds) => {
            perform(async () => {
              const result = await confirmReference({
                ...input,
                sessionId: preview.sessionId,
                candidateIds,
              });
              updatePreview(null);
              setCamera(false);
              setNotice(
                `登记完成：已为「${member.name}」保存 ${result.count} 张参考照片。`,
              );
            }, "正在保存选中的照片，请稍候…");
          }}
          cancel={(retry) => {
            perform(async () => {
              await cancelReference({ ...input, sessionId: preview.sessionId });
              updatePreview(null);
              setCamera(retry && preview.source !== null);
              setNotice(
                retry
                  ? "请选择摄像头重新录制，或上传其他照片。"
                  : "本次登记已取消，没有保存新的参考照片。",
              );
            }, "正在释放候选照片…");
          }}
        />
      ) : null}
      {references.data?.samples.length ? (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          aria-label="已保存的参考照片"
        >
          {references.data?.samples.map((sample) => (
            <figure
              key={sample.id}
              className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-white p-3"
            >
              <ReferencePhoto
                alt={`${member.name}的已保存参考照片`}
                src={`/api/household-members/references/image/${sample.id}?${new URLSearchParams(input)}`}
              />
              <figcaption className="text-xs text-muted">
                {sample.outdated ? (
                  <span className="mb-1 block font-medium text-amber-700">
                    参考已失效，请删除后重新登记
                  </span>
                ) : null}
                {sample.source.kind === "upload"
                  ? "上传照片"
                  : `摄像头录像 · 镜头 ${sample.source.channel}`}
              </figcaption>
              <Button
                className="mt-auto self-start"
                size="small"
                variant="secondary"
                disabled={busy || camera || !!preview}
                onClick={() => {
                  perform(
                    () => deleteReference(input, sample.id),
                    "正在删除参考照片…",
                  );
                }}
              >
                删除参考
              </Button>
            </figure>
          ))}
        </div>
      ) : null}
    </ImageDropZone>
  );
}

function ReferencePreview({
  initial,
  input,
  busy,
  confirm,
  cancel,
}: {
  initial: z.infer<typeof referencePreviewSchema>;
  input: z.infer<typeof referenceMemberSchema>;
  busy: boolean;
  confirm: (ids: string[]) => void;
  cancel: (retry: boolean) => void;
}) {
  const query = useQuery({
    ...referencePreviewOptions({ ...input, sessionId: initial.sessionId }),
    initialData: initial,
  });
  const preview = query.data;
  const [now, setNow] = useState(Date.now);
  const [picked, pick] = useState<string[]>([]);
  const expired = now >= initial.expiresAt;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((initial.expiresAt - now) / 1000));
  const hasCandidates = preview.candidates.length > 0;
  return (
    <div className="space-y-4 rounded-xl border border-line bg-white p-4">
      <div aria-live="polite" className="space-y-2">
        <p className="text-xs text-muted">
          {preview.source ? "录制已结束 → 提取已完成 → " : "照片分析已完成 → "}
          挑选并保存
        </p>
        <h3 className="text-sm font-medium">
          {expired
            ? "候选确认期限已结束"
            : hasCandidates
              ? `已提取 ${preview.candidates.length} 张参考照片，请选择属于此成员的清晰照片`
              : "未提取到可保存的参考照片"}
        </h3>
        <p className="text-xs text-muted">
          {expired
            ? "请检查已保存照片后，重新添加照片。"
            : `已选 ${picked.length} 张 · 还可保存 ${preview.remainingCapacity} 张 · 确认剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
        </p>
      </div>
      {preview.reason ? <Notice tone="warning">{preview.reason}</Notice> : null}
      {preview.uploads.length ? (
        <div className="space-y-2 text-xs" aria-label="本批照片处理结果">
          {preview.uploads.map((file, index) => (
            <p key={index} className="break-words leading-6">
              <span className="font-medium">{file.fileName}</span>
              {file.candidateIds.length
                ? `：已提取 ${file.candidateIds.length} 张候选`
                : "：未添加候选"}
              {file.reason ? ` · ${file.reason}` : ""}
            </p>
          ))}
        </div>
      ) : null}
      {query.error && !expired ? (
        <Notice tone="error">
          {requestErrorMessage(query.error)}
          <Button
            size="small"
            disabled={query.isFetching}
            onClick={async () => {
              await query.refetch();
            }}
          >
            重新获取状态
          </Button>
        </Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {preview.candidates.map((candidate, index) => {
          const selected = picked.includes(candidate.id);
          return (
            <button
              type="button"
              key={candidate.id}
              aria-pressed={selected}
              aria-label={`选择候选照片 ${index + 1}${candidate.fileName ? `：${candidate.fileName}` : ""}`}
              disabled={
                busy ||
                expired ||
                !!query.error ||
                (!selected && picked.length >= preview.remainingCapacity)
              }
              className={`relative flex min-w-0 flex-col gap-2 rounded-xl border-2 p-2 text-left disabled:opacity-50 ${selected ? "border-ink bg-surface" : "border-line"}`}
              onClick={() =>
                pick((previous) =>
                  selected
                    ? previous.filter((id) => id !== candidate.id)
                    : [...previous, candidate.id],
                )
              }
            >
              <ReferencePhoto
                src={candidate.image}
                alt={`候选照片 ${index + 1}`}
              />
              <span className="mt-auto flex w-full items-center justify-between gap-2 text-xs">
                <span
                  className="min-w-0 truncate"
                  title={candidate.fileName ?? undefined}
                >
                  {preview.source
                    ? `录像约第 ${candidate.offsetMs / 1000 + 1} 秒`
                    : candidate.fileName}
                </span>
                <span className="shrink-0">{selected ? "✓ 已选" : "选择"}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={
            busy ||
            expired ||
            !!query.error ||
            !picked.length ||
            picked.length > preview.remainingCapacity
          }
          onClick={() => confirm(picked)}
        >
          保存选中的 {picked.length} 张照片
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => cancel(true)}
        >
          {preview.source ? "重新录制" : "重新选图"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => cancel(false)}>
          取消，不保存
        </Button>
      </div>
      <p className="text-xs text-muted">
        仅保存你选中的参考照片，其余候选和临时录像会释放。保存完成后会显示登记完成提示。
      </p>
    </div>
  );
}

function ReferencePhoto({ src, alt }: { src: string; alt: string }) {
  return (
    <span className="block aspect-[3/4] w-full shrink-0 overflow-hidden rounded-lg bg-surface">
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="size-full select-none object-contain"
      />
    </span>
  );
}
