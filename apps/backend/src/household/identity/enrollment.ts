import { isDeepStrictEqual } from "node:util";
import { selectPetPhotoRegions } from "../../perception/identity/pet-regions";
import { HouseholdError } from "../errors";
import {
  identityCapacity,
  identityEnrollmentLimits,
} from "@home-agent/api/contracts";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type {
  identityReferenceSnapshotSchema,
  referenceRecordingSchema,
  referenceMemberSchema,
  referenceSessionSchema,
  referenceConfirmSchema,
  referencePreviewSchema,
} from "@home-agent/api/contracts";
import type { createIdentityReferences } from "./references";
import type { createPerceptionService } from "../../perception/service";
import type { PerceptionSources } from "../../perception/sources";
import type { createMemberAccess } from "../members/access";
import type { extractedReferenceSchema } from "../../perception/identity/enrollment-protocol";
import { extractReferenceFrames } from "../../perception/identity/recording";
import { identityProcessingVersions } from "../../perception/identity/processing-version";
import { ReferenceEnrollmentError } from "./errors";

// Owns temporary candidates and the single confirmation that turns them into references.
export function createReferenceEnrollment(
  references: ReturnType<typeof createIdentityReferences>,
  perception: ReturnType<typeof createPerceptionService>,
  access: ReturnType<typeof createMemberAccess>,
  options: {
    executable: string;
    sources: Pick<PerceptionSources, "eligibility">;
  },
) {
  let session:
    | {
        id: string;
        member: z.infer<typeof referenceMemberSchema>;
        source: z.infer<typeof referencePreviewSchema>["source"];
        sourceGrant: string | undefined;
        className: z.infer<
          typeof identityReferenceSnapshotSchema
        >["members"][number]["className"];
        expiresAt: number;
        deadline: number;
        reason: string | null;
        candidates: (z.infer<typeof extractedReferenceSchema> & {
          id: string;
          offsetMs: number;
        })[];
        remainingCapacity: number;
        versions: ReturnType<
          typeof identityProcessingVersions
        >["adapters"]["human"];
      }
    | undefined;
  let busy = false;
  let closed = false;
  function cancel(selected = session) {
    if (session === selected) session = undefined;
  }
  function assertSession(selected: NonNullable<typeof session>) {
    if (
      closed ||
      session !== selected ||
      performance.now() >= selected.deadline
    )
      throw new ReferenceEnrollmentError("enrollment_unavailable");
    if (
      selected.source &&
      options.sources.eligibility(selected.source)?.identity !==
        selected.sourceGrant
    )
      throw new ReferenceEnrollmentError("source_unavailable");
  }
  async function validate(input: z.infer<typeof referenceMemberSchema>) {
    const context = access(input.scope_epoch);
    const listed = await references.list(
      context.identity,
      context.assertCurrent,
      input.memberId,
    );
    if (
      session?.member.memberId === input.memberId &&
      session.member.scope_epoch === input.scope_epoch
    ) {
      if (
        listed.className !== session.className ||
        !isDeepStrictEqual(
          references.matching.referenceVersions(session.className),
          session.versions,
        )
      ) {
        cancel();
        throw new ReferenceEnrollmentError("enrollment_unavailable");
      }
    }
    return { ...context, listed };
  }
  async function current(input: z.infer<typeof referenceSessionSchema>) {
    await validate(input);
    if (
      !session ||
      session.id !== input.sessionId ||
      session.member.memberId !== input.memberId ||
      session.member.scope_epoch !== input.scope_epoch
    )
      throw new ReferenceEnrollmentError("enrollment_unavailable");
    assertSession(session);
    return session;
  }
  function preview(selected: NonNullable<typeof session>) {
    return {
      sessionId: selected.id,
      memberId: selected.member.memberId,
      source: selected.source,
      expiresAt: selected.expiresAt,
      reason: selected.reason,
      remainingCapacity: selected.remainingCapacity,
      candidates: selected.candidates.map((candidate) => ({
        id: candidate.id,
        offsetMs: candidate.offsetMs,
        quality: {
          sharpness: candidate.sharpness,
          detectionScore: candidate.detectionScore,
        },
        image: `data:image/jpeg;base64,${candidate.image}`,
      })),
    } satisfies z.infer<typeof referencePreviewSchema>;
  }
  async function extract(
    input: z.infer<typeof referenceMemberSchema>,
    source: NonNullable<typeof session>["source"],
    path: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (closed) throw new ReferenceEnrollmentError("model_unavailable");
    if (busy || session) throw new ReferenceEnrollmentError("busy");
    busy = true;
    let selected: Parameters<typeof assertSession>[0] | undefined;
    try {
      const { listed } = await validate(input);
      signal.throwIfAborted();
      const className = listed.className;
      if (!className || (source && className !== "human"))
        throw new HouseholdError("invalid_state");
      const config = perception.identityConfig();
      if (!config || closed)
        throw new ReferenceEnrollmentError("model_unavailable");
      const grant = source ? options.sources.eligibility(source) : null;
      if (source && (!grant || grant.scopeEpoch !== input.scope_epoch))
        throw new ReferenceEnrollmentError("source_unavailable");
      selected = session = {
        id: crypto.randomUUID(),
        member: input,
        className,
        source,
        sourceGrant: grant?.identity,
        expiresAt: 0,
        deadline: Infinity,
        reason: null,
        candidates: [],
        remainingCapacity: Math.max(
          0,
          identityCapacity.referencesPerMember - listed.samples.length,
        ),
        versions: identityProcessingVersions(config.minimumSharpness).adapters[
          className
        ],
      };
      const frames = source
        ? await extractReferenceFrames(options.executable, path, signal).catch(
            (cause: unknown) => {
              signal.throwIfAborted();
              console.warn("Reference recording decode failed", cause);
              throw new ReferenceEnrollmentError("invalid_recording");
            },
          )
        : [{ path, offsetMs: 0 }];
      const saved = new Set(listed.samples.map((sample) => sample.sha256));
      for (const frame of frames) {
        signal.throwIfAborted();
        assertSession(selected);
        access(input.scope_epoch).assertCurrent();
        const detection =
          className === "human"
            ? null
            : await perception.detectImage({ path: frame.path }, signal);
        signal.throwIfAborted();
        assertSession(selected);
        const detectedRegions =
          detection?.detections.flatMap((item, index) =>
            item.className === "cat" || item.className === "dog"
              ? [
                  {
                    trackId: index + 1,
                    className: item.className,
                    measuredBox: {
                      x: item.x,
                      y: item.y,
                      w: item.w,
                      h: item.h,
                    },
                  },
                ]
              : [],
          ) ?? [];
        const petPhoto =
          className === "human"
            ? null
            : selectPetPhotoRegions(detectedRegions, className);
        if (petPhoto?.reason) {
          selected.reason = petPhoto.reason;
          continue;
        }
        const result = await perception.enrollment({
          kind: "identity_extract",
          config,
          image: { path: frame.path },
          mode: source ? "video_frame" : "photo",
          className,
          regions: petPhoto?.regions ?? [],
        });
        signal.throwIfAborted();
        assertSession(selected);
        if (result.kind !== "enrollment")
          throw new Error("Unexpected extraction result");
        if (result.reason) selected.reason = result.reason;
        for (const face of result.candidates) {
          if (
            saved.has(
              createHash("sha256")
                .update(Buffer.from(face.image, "base64"))
                .digest("hex"),
            )
          ) {
            selected.reason =
              "提取的照片已作为该成员的参考保存，重复照片已忽略";
            continue;
          }
          if (
            selected.candidates.some(
              (candidate) => candidate.cropSha256 === face.cropSha256,
            )
          )
            continue;
          selected.candidates.push({
            ...face,
            id: crypto.randomUUID(),
            offsetMs: frame.offsetMs,
          });
          selected.candidates.sort((a, b) => b.sharpness - a.sharpness);
          selected.candidates.splice(identityEnrollmentLimits.candidates);
        }
      }
      await validate(input);
      signal.throwIfAborted();
      assertSession(selected);
      selected.reason = selected.candidates.length
        ? null
        : (selected.reason ??
          "没有提取到清晰人脸，请靠近摄像头并正对镜头重新录制");
      selected.expiresAt = Date.now() + identityEnrollmentLimits.confirmationMs;
      selected.deadline =
        performance.now() + identityEnrollmentLimits.confirmationMs;
      return preview(selected);
    } catch (error) {
      if (selected) cancel(selected);
      throw error;
    } finally {
      busy = false;
    }
  }
  async function reconcile() {
    const selected = session;
    if (!selected) return;
    try {
      await validate(selected.member);
      assertSession(selected);
    } catch (error) {
      cancel(selected);
      console.info(
        "Reference enrollment released after ownership check",
        error,
      );
    }
  }
  let pruning = false;
  const timer = setInterval(() => {
    if (!session || pruning) return;
    pruning = true;
    reconcile()
      .catch((error) => console.error("Reference cleanup failed", error))
      .finally(() => {
        pruning = false;
      });
  }, 1000);
  return {
    async list(input: z.infer<typeof referenceMemberSchema>) {
      const { listed } = await validate(input);
      const samples = listed.samples.map((sample) => ({
        id: sample.id,
        source: sample.source,
        quality: sample.quality,
        createdAt: sample.createdAt.toISOString(),
      }));
      if (!listed.className)
        return {
          enabled: false,
          enableReason: "当前只支持人物、猫和狗，请在宠物资料中填写猫或狗。",
          model: "unconfigured" as const,
          modelReason: "当前只支持人物、猫和狗，请先检查宠物物种。",
          samples,
        };
      const health = await perception
        .identityModelStatus(listed.className)
        .catch((error) => {
          console.error("Identity model status unavailable", error);
          return {
            status: "unavailable" as const,
            reason: "身份计算进程不可用",
          };
        });
      return {
        enabled: listed.enabled,
        enableReason: references.matching
          .snapshot()
          ?.members.some((member) => member.memberId === input.memberId)
          ? null
          : "没有可用的识别参考，请添加清晰的人物或猫狗照片。",
        model: perception.identityConfig()
          ? health.status
          : ("unconfigured" as const),
        modelReason: health.reason,
        samples,
      };
    },
    upload(
      input: z.infer<typeof referenceMemberSchema>,
      path: string,
      signal: AbortSignal,
    ) {
      return extract(input, null, path, signal);
    },
    recording(
      input: z.infer<typeof referenceRecordingSchema>,
      path: string,
      signal: AbortSignal,
    ) {
      const { memberId, scope_epoch, ...source } = input;
      return extract({ memberId, scope_epoch }, source, path, signal);
    },
    async poll(input: z.infer<typeof referenceSessionSchema>) {
      const selected = await current(input);
      const { listed } = await validate(input);
      assertSession(selected);
      selected.remainingCapacity = Math.max(
        0,
        identityCapacity.referencesPerMember - listed.samples.length,
      );
      return preview(selected);
    },
    cancel(input: z.infer<typeof referenceSessionSchema>) {
      if (
        session?.id === input.sessionId &&
        session.member.memberId === input.memberId &&
        session.member.scope_epoch === input.scope_epoch
      )
        cancel();
      return { cancelled: true as const };
    },
    async confirm(input: z.infer<typeof referenceConfirmSchema>) {
      if (busy) throw new ReferenceEnrollmentError("busy");
      busy = true;
      try {
        const selected = await current(input);
        const candidates = input.candidateIds.map((id) => {
          const candidate = selected.candidates.find((item) => item.id === id);
          if (!candidate)
            throw new ReferenceEnrollmentError("enrollment_unavailable");
          return candidate;
        });
        const context = await validate(input);
        const assert = () => {
          context.assertCurrent();
          assertSession(selected);
        };
        const result = await references.save(
          context.identity,
          assert,
          candidates.map((candidate) => ({
            reference: {
              memberId: input.memberId,
              source: selected.source
                ? {
                    kind: "recording" as const,
                    ...selected.source,
                    offsetMs: candidate.offsetMs,
                  }
                : { kind: "upload" as const },
              quality: {
                sharpness: candidate.sharpness,
                detectionScore: candidate.detectionScore,
              },
              ...selected.versions,
              feature: candidate.feature,
              contentType: "image/jpeg" as const,
            },
            image: Buffer.from(candidate.image, "base64"),
          })),
        );
        cancel(selected);
        return { saved: true as const, count: result.count };
      } finally {
        busy = false;
      }
    },
    reconcile,
    close() {
      closed = true;
      clearInterval(timer);
      cancel();
    },
  };
}
