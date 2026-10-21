import { prepareAnalysisImage } from "../perception/image-analysis";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  referenceListSchema,
  referenceSavedSchema,
  referenceCancelledSchema,
  referencePreviewSchema,
  type referenceToggleSchema,
  type referenceMemberSchema,
  type referenceRecordingSchema,
  identityEnrollmentLimits,
  type referenceSessionSchema,
  type referenceConfirmSchema,
} from "@home-agent/api/contracts";
import { requestJson } from "../../api/client";

export function referenceListOptions(
  input: z.infer<typeof referenceMemberSchema>,
) {
  return queryOptions({
    queryKey: ["member-references", input],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api["household-members"].references.list.$post(
            { json: input },
            options,
          ),
        referenceListSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: 5000,
  });
}
async function receiveReferencePreview(
  input: z.infer<typeof referenceSessionSchema>,
  send: () => Promise<z.infer<typeof referencePreviewSchema>>,
) {
  try {
    return await send();
  } catch (cause) {
    await cancelReference(input);
    throw cause;
  }
}
export async function uploadReference(
  input: z.infer<typeof referenceMemberSchema>,
  files: File[],
  signal: AbortSignal,
) {
  if (!files.length || files.length > identityEnrollmentLimits.candidates)
    throw new Error(
      `每次请选择 1 至 ${identityEnrollmentLimits.candidates} 张照片。`,
    );
  if (
    files.reduce((total, file) => total + file.size, 0) >
    identityEnrollmentLimits.uploadBytes
  )
    throw new Error("每批照片总大小不能超过 32 MiB，请减少照片或先缩小图片。");

  const operationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(identityEnrollmentLimits.extractionMs),
  ]);
  const body = new FormData();
  let total = 0;
  for (const file of files) {
    const prepared = await prepareAnalysisImage(file, operationSignal).catch(
      (cause: unknown) => {
        operationSignal.throwIfAborted();
        throw new Error(
          `「${file.name}」：${cause instanceof Error ? cause.message : "图片准备失败"}，本批照片尚未提交。`,
          { cause },
        );
      },
    );
    try {
      total += prepared.blob.size;
      if (total > identityEnrollmentLimits.uploadBytes)
        throw new Error(
          "处理后的照片总大小超过 32 MiB，请减少照片或先缩小图片。",
        );
      body.append("images", prepared.blob, file.name);
    } finally {
      URL.revokeObjectURL(prepared.url);
    }
  }
  operationSignal.throwIfAborted();
  const session = { ...input, sessionId: crypto.randomUUID() };
  return receiveReferencePreview(session, () =>
    requestJson(
      (api, options) =>
        api.api["household-members"].references.upload.$post(
          { query: session },
          {
            init: {
              ...options.init,
              body,
            },
          },
        ),
      referencePreviewSchema,
      {
        timeoutMs: identityEnrollmentLimits.extractionMs,
        signal: operationSignal,
      },
    ),
  );
}
export function extractRecording(
  input: Omit<z.infer<typeof referenceRecordingSchema>, "sessionId">,
  recording: Blob,
  signal: AbortSignal,
) {
  const session = {
    memberId: input.memberId,
    scope_epoch: input.scope_epoch,
    sessionId: crypto.randomUUID(),
  };
  return receiveReferencePreview(session, () =>
    requestJson(
      (api, options) =>
        api.api["household-members"].references.recording.$post(
          { query: { ...input, ...session, channel: String(input.channel) } },
          {
            init: {
              ...options.init,
              body: recording,
              headers: { "Content-Type": recording.type },
            },
          },
        ),
      referencePreviewSchema,
      { signal, timeoutMs: identityEnrollmentLimits.extractionMs },
    ),
  );
}
export function referencePreviewOptions(
  input: z.infer<typeof referenceSessionSchema>,
) {
  return queryOptions({
    queryKey: ["reference-preview", input],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api["household-members"].references.preview.$post(
            { json: input },
            options,
          ),
        referencePreviewSchema,
        { signal },
      ),
    refetchInterval: (query) => (query.state.error ? false : 5000),
    retry: false,
    gcTime: 0,
  });
}
export function cancelReference(input: z.infer<typeof referenceSessionSchema>) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].references.cancel.$post(
        { json: input },
        options,
      ),
    referenceCancelledSchema,
    { keepalive: true, timeoutMs: identityEnrollmentLimits.extractionMs },
  );
}
export function confirmReference(
  input: z.infer<typeof referenceConfirmSchema>,
) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].references.confirm.$post(
        { json: input },
        options,
      ),
    referenceSavedSchema,
  );
}
export function deleteReference(
  input: z.infer<typeof referenceMemberSchema>,
  sampleId: string,
) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].references.delete.$post(
        { json: { ...input, sampleId } },
        options,
      ),
    referenceListSchema,
  );
}
export function toggleIdentity(input: z.infer<typeof referenceToggleSchema>) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].references.toggle.$post(
        { json: input },
        options,
      ),
    referenceListSchema,
  );
}
