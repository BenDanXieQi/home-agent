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
export async function uploadReference(
  input: z.infer<typeof referenceMemberSchema>,
  file: File,
  signal?: AbortSignal,
) {
  const prepared = await prepareAnalysisImage(
    file,
    signal ?? AbortSignal.timeout(45_000),
  );
  try {
    return await requestJson(
      (api, options) =>
        api.api["household-members"].references.upload.$post(
          { query: input },
          {
            init: {
              ...options.init,
              body: prepared.blob,
              headers: {
                "Content-Type": "image/png",
              },
            },
          },
        ),
      referencePreviewSchema,
      { timeoutMs: 45_000, signal },
    );
  } finally {
    URL.revokeObjectURL(prepared.url);
  }
}
export function extractRecording(
  input: z.infer<typeof referenceRecordingSchema>,
  recording: Blob,
  signal: AbortSignal,
) {
  return requestJson(
    (api, options) =>
      api.api["household-members"].references.recording.$post(
        { query: { ...input, channel: String(input.channel) } },
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
    { keepalive: true },
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
