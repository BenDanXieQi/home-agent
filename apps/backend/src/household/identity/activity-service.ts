import PQueue from "p-queue";
import pTimeout from "p-timeout";
import { isDeepStrictEqual } from "node:util";
import {
  memberActivityAttributionSchema,
  attributionTriggerSchema,
  type memberAttributionSnapshotSchema,
  type memberAssociationSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { HouseholdRuntime } from "../runtime";
import type { createPerceptionService } from "../../perception/service";
import type { createMemberActivityRepository } from "./activity-repository";
import { createMemberAccess } from "../members/access";
import { HouseholdError } from "../errors";
import {
  memberActivity,
  activityReferences,
  activitySupportVersions,
} from "./activity";

const activityCapacity = 256;

function pendingActivity(activity: ReturnType<typeof memberActivity>) {
  return {
    activity,
    savedRevision: 0,
    savedCorrectionCount: 0,
    savedAt: 0,
    savedState: "",
    queued: false,
    waiting: null as AbortController | null,
    suspended: false,
    discardedRevision: null as number | null,
    terminalChecked: false,
    endingAt: null as number | null,
    retryAt: 0,
    inFlight: null as { activity: typeof activity; revoked: boolean } | null,
  };
}

function stateSignature(activity: ReturnType<typeof memberActivity>) {
  const current = activity.record.data.attribution.current;
  return current.kind === "unknown"
    ? "unknown"
    : `${current.association.basis}:${current.association.memberId}:${current.association.state}`;
}
// This owner accumulates every accepted correction before queue coalescing.
export function createMemberActivityService(
  household: HouseholdRuntime,
  perception: Pick<
    ReturnType<typeof createPerceptionService>,
    | "snapshot"
    | "subscribe"
    | "appearance"
    | "referenceVersions"
    | "petCandidates"
  >,
  repository: ReturnType<typeof createMemberActivityRepository>,
) {
  const access = createMemberAccess(household);
  const queue = new PQueue({ concurrency: 1 });
  const writes = new Set<Promise<void>>();
  const entries = new Map<string, ReturnType<typeof pendingActivity>>();
  // Source-target dependencies survive reference expiry and successful writes.
  const dependents = new Map<string, Set<string>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let capacityWarningAt = 0;
  let scope = household.snapshot().scope_epoch;
  let referenceVersions = perception.referenceVersions();
  function retireEntries() {
    for (const entry of entries.values()) {
      entry.waiting?.abort(new HouseholdError("stale_session"));
      if (entry.inFlight) entry.inFlight.revoked = true;
    }
    entries.clear();
    dependents.clear();
  }
  function dependencies() {
    dependents.clear();
    for (const [key, entry] of entries) {
      for (const reference of [
        ...activityReferences(entry.activity.record.data.attribution.current),
        ...activityReferences(
          entry.inFlight?.activity.record.data.attribution.current ??
            entry.activity.record.data.attribution.current,
        ),
      ]) {
        const keys =
          dependents.get(reference.sourceTargetKey) ?? new Set<string>();
        keys.add(key);
        dependents.set(reference.sourceTargetKey, keys);
      }
    }
  }
  function createEntry(
    key: string,
    association: z.infer<typeof memberAssociationSchema>,
  ) {
    const state = household.snapshot();
    const run = association.run;
    if (closed || !household.ready || run.scopeEpoch !== state.scope_epoch)
      return undefined;
    const device = Object.values(state.projection.device).find(
      (item) => !item.archived && item.device_id === run.deviceId,
    );
    if (!device) return undefined;
    if (entries.size >= activityCapacity) {
      if (Date.now() >= capacityWarningAt) {
        console.error("Member activity capacity reached");
        capacityWarningAt = Date.now() + 5000;
      }
      return undefined;
    }
    const room = device.room_id
      ? Object.values(state.projection.room).find(
          (item) => !item.archived && item.room_id === device.room_id,
        )
      : undefined;
    const current = {
      kind: "known" as const,
      association,
      acceptedAt: Date.now(),
    };
    const entry = pendingActivity(
      memberActivity(crypto.randomUUID(), {
        run,
        mediaGeneration: association.mediaGeneration,
        trackId: association.trackId,
        sourceRunId: run.runId,
        deviceId: run.deviceId,
        channel: run.channel,
        deviceName: device.alias || device.name,
        cameraRoomName: room?.name ?? null,
        firstObservedAt: association.observedAt,
        lastObservedAt: association.observedAt,
        endedAt: null,
        timeBasis: "host_received_at",
        attribution: {
          original: current,
          current,
          revision: 1,
          correctionCount: 0,
          lastCorrection: null,
        },
      }),
    );
    entries.set(key, entry);
    dependencies();
    return entry;
  }
  function discard(entry: ReturnType<typeof pendingActivity>) {
    if (entry.activity.record.data.attribution.current.kind !== "known") return;
    entry.suspended = true;
    entry.discardedRevision = entry.activity.record.data.attribution.revision;
  }
  function attributionEligible(
    current: z.infer<typeof memberAttributionSnapshotSchema>,
  ) {
    if (current.kind === "known" && current.association.basis === "species") {
      const pet = perception.petCandidates(current.association.className);
      return (
        pet?.members.length === 1 &&
        pet.members[0]?.memberId === current.association.memberId
      );
    }
    return activitySupportVersions(current).every((version) =>
      isDeepStrictEqual(version, perception.referenceVersions()),
    );
  }
  function eligible(entry: ReturnType<typeof pendingActivity>) {
    return (
      !entry.suspended &&
      attributionEligible(entry.activity.record.data.attribution.current)
    );
  }
  function release(key: string, entry: ReturnType<typeof pendingActivity>) {
    if (
      entry.terminalChecked &&
      !entry.queued &&
      (entry.savedRevision ===
        entry.activity.record.data.attribution.revision ||
        entry.discardedRevision ===
          entry.activity.record.data.attribution.revision) &&
      entries.get(key) === entry
    ) {
      entries.delete(key);
      dependencies();
    }
  }
  function schedule(
    key: string,
    entry: ReturnType<typeof pendingActivity>,
    final = false,
  ) {
    const attribution = entry.activity.record.data.attribution;
    if (
      !household.ready ||
      entry.activity.record.scopeEpoch !== household.snapshot().scope_epoch ||
      entry.queued ||
      writes.size >= activityCapacity ||
      !eligible(entry) ||
      entry.savedRevision === attribution.revision ||
      (!final && entry.retryAt > Date.now())
    )
      return;
    if (
      !final &&
      !entry.terminalChecked &&
      entry.savedRevision &&
      entry.savedCorrectionCount === attribution.correctionCount &&
      entry.savedState === stateSignature(entry.activity) &&
      Date.now() - entry.savedAt < 10_000
    )
      return;
    entry.queued = true;
    const waiting = new AbortController();
    entry.waiting = waiting;
    const writing = queue
      .add(
        async () => {
          // The queue signal only cancels waiting tasks. Running storage retains
          // its serial slot until the transaction has actually settled.
          entry.waiting = null;
          if (entries.get(key) !== entry || !eligible(entry)) return;
          const activity = structuredClone(entry.activity);
          const selected = { activity, revoked: false };
          entry.inFlight = selected;
          dependencies();
          const context = access(activity.record.scopeEpoch);
          const assertCurrent = () => {
            context.assertCurrent();
            if (
              entries.get(key) !== entry ||
              selected.revoked ||
              !attributionEligible(activity.record.data.attribution.current)
            )
              throw new HouseholdError("stale_session");
          };
          if (
            entry.activity.record.data.attribution.revision !==
            activity.record.data.attribution.revision
          )
            return;
          assertCurrent();
          const receipt = await repository.save(
            context.identity,
            assertCurrent,
            activity,
          );
          if (receipt.status === "saved") {
            entry.savedRevision = activity.record.data.attribution.revision;
            entry.savedCorrectionCount =
              activity.record.data.attribution.correctionCount;
            entry.savedState = stateSignature(activity);
            entry.savedAt = Date.now();
            entry.retryAt = 0;
          } else if (
            entry.activity.record.data.attribution.revision ===
            activity.record.data.attribution.revision
          ) {
            // Invalid reference or member eligibility cannot become valid by retrying old evidence.
            discard(entry);
          }
        },
        { signal: waiting.signal },
      )
      .catch((error: unknown) => {
        if (waiting.signal.aborted) return;
        if (
          error instanceof HouseholdError &&
          error.reason === "stale_session"
        ) {
          if (
            entry.inFlight?.activity.record.data.attribution.revision ===
            entry.activity.record.data.attribution.revision
          )
            entry.retryAt = Date.now() + 1000;
          return;
        }
        entry.retryAt = Date.now() + 5000;
        console.error("Member activity storage failed", error);
      })
      .finally(() => {
        writes.delete(writing);
        entry.queued = false;
        entry.waiting = null;
        entry.inFlight = null;
        dependencies();
        release(key, entry);
        // An old receipt acknowledges only its selected version. Corrections bypass throttling.
        if (entries.get(key) === entry && !closed) schedule(key, entry);
      });
    writes.add(writing);
  }
  function accept(
    entry: ReturnType<typeof pendingActivity>,
    next: z.infer<typeof memberAttributionSnapshotSchema>,
  ) {
    const previous = entry.activity.record.data.attribution;
    const before = previous.current;
    let reason:
      | NonNullable<
          z.infer<typeof memberActivityAttributionSchema>["lastCorrection"]
        >["reason"]
      | null = null;
    if (next.kind === "unknown") reason = next.reason;
    else if (
      before.kind === "unknown" ||
      before.association.memberId !== next.association.memberId
    )
      reason = "member_changed";
    else if (
      before.association.state !== "confirmed" &&
      next.association.basis !== "appearance" &&
      next.association.state === "confirmed"
    )
      reason = "direct_confirmation";
    const attribution = memberActivityAttributionSchema.parse({
      ...previous,
      current: next,
      revision: previous.revision + 1,
      correctionCount: previous.correctionCount + (reason ? 1 : 0),
      lastCorrection: reason
        ? {
            before,
            after: next,
            reason,
            trigger: next.kind === "known" ? next.association : next.trigger,
            processedAt: next.acceptedAt,
          }
        : previous.lastCorrection,
    });
    const data = entry.activity.record.data;
    entry.activity = memberActivity(entry.activity.record.id, {
      ...data,
      lastObservedAt: Math.max(
        data.lastObservedAt,
        next.kind === "known" ? next.association.observedAt : next.observedAt,
      ),
      attribution,
    });
    entry.suspended = false;
    entry.discardedRevision = null;
    entry.retryAt = 0;
    dependencies();
  }
  function end(
    key: string,
    entry: ReturnType<typeof pendingActivity>,
    endedAt: number | null,
    lastObservedAt: number | null,
  ) {
    if (entry.terminalChecked) return;
    entry.terminalChecked = true;
    // Version invalidation abandons an unsavable snapshot; it does not rewrite history or claim a storage receipt.
    if (
      !eligible(entry) &&
      entry.activity.record.data.attribution.current.kind === "known"
    ) {
      discard(entry);
      release(key, entry);
      return;
    }
    const data = entry.activity.record.data;
    entry.activity = memberActivity(entry.activity.record.id, {
      ...data,
      lastObservedAt: Math.max(
        data.lastObservedAt,
        lastObservedAt ?? data.lastObservedAt,
      ),
      endedAt,
      attribution: {
        ...data.attribution,
        revision: data.attribution.revision + 1,
      },
    });
    schedule(key, entry);
    release(key, entry);
  }
  const unsubscribeAppearance = perception.appearance?.subscribe((event) => {
    if (event.kind === "target_identity") {
      const entry =
        entries.get(event.sourceTargetKey) ??
        (event.update.kind === "confirmed"
          ? createEntry(event.sourceTargetKey, event.update.association)
          : undefined);
      if (!entry || entry.terminalChecked) return;
      const current = entry.activity.record.data.attribution.current;
      if (event.update.kind === "confirmed") {
        if (
          current.kind !== "known" ||
          !isDeepStrictEqual(current.association, event.update.association)
        ) {
          accept(entry, {
            kind: "known",
            association: event.update.association,
            acceptedAt: Date.now(),
          });
        }
        schedule(event.sourceTargetKey, entry);
      } else {
        if (
          entry.inFlight &&
          activityReferences(
            entry.inFlight.activity.record.data.attribution.current,
          ).length
        )
          entry.inFlight.revoked = true;
        if (
          current.kind !== "known" ||
          current.association.basis !== "appearance"
        )
          return;
        accept(entry, {
          kind: "unknown",
          reason: "target_face_conflict",
          observedAt:
            event.update.trigger.track.lastEvidenceAt ??
            entry.activity.record.data.lastObservedAt,
          acceptedAt: Date.now(),
          trigger: attributionTriggerSchema.parse({
            sourceTargetKey: event.sourceTargetKey,
            referenceIds: current.association.referenceIds,
            references: current.association.references,
            reason: "target_face_conflict",
            trigger: event.update.trigger,
          }),
        });
        schedule(event.sourceTargetKey, entry);
      }
    } else if (event.kind === "reference_revoked") {
      const keys = [...(dependents.get(event.sourceTargetKey) ?? [])];
      for (const key of keys) {
        const entry = entries.get(key);
        if (!entry) continue;
        if (
          entry.inFlight &&
          activityReferences(
            entry.inFlight.activity.record.data.attribution.current,
          ).some(
            (reference) => reference.sourceTargetKey === event.sourceTargetKey,
          )
        )
          entry.inFlight.revoked = true;
        const references = activityReferences(
          entry.activity.record.data.attribution.current,
        ).filter(
          (reference) => reference.sourceTargetKey === event.sourceTargetKey,
        );
        if (references.length) {
          const trigger = attributionTriggerSchema.parse({
            ...event,
            referenceIds: references.map((reference) => reference.referenceId),
            references,
          });
          accept(entry, {
            kind: "unknown",
            reason: "reference_revoked",
            observedAt:
              event.trigger?.track.lastEvidenceAt ??
              entry.activity.record.data.lastObservedAt,
            acceptedAt: Date.now(),
            trigger,
          });
          schedule(key, entry);
        }
      }
    } else if (event.kind === "references_invalidated") {
      for (const entry of entries.values()) {
        if (
          event.reason === "reference_versions_changed" &&
          activitySupportVersions(
            entry.activity.record.data.attribution.current,
          ).length
        ) {
          discard(entry);
          if (
            entry.inFlight?.activity.record.data.attribution.current.kind ===
            "known"
          )
            entry.inFlight.revoked = true;
        }
      }
    } else if (event.kind === "target_ended") {
      const entry = entries.get(event.sourceTargetKey);
      if (entry)
        end(
          event.sourceTargetKey,
          entry,
          event.observedEndedAt,
          event.lastObservedAt,
        );
    }
  });
  function collect() {
    if (closed) return;
    const householdState = household.snapshot();
    if (householdState.scope_epoch !== scope) {
      retireEntries();
      scope = householdState.scope_epoch;
    }
    if (!household.ready) return;
    const versions = perception.referenceVersions();
    if (!isDeepStrictEqual(versions, referenceVersions)) {
      referenceVersions = versions;
      for (const entry of entries.values()) {
        if (
          !activitySupportVersions(
            entry.activity.record.data.attribution.current,
          ).length
        )
          continue;
        discard(entry);
        if (
          entry.inFlight?.activity.record.data.attribution.current.kind ===
          "known"
        )
          entry.inFlight.revoked = true;
      }
    }
    const snapshot = perception.snapshot();
    const devices = new Set(
      Object.values(householdState.projection.device)
        .filter((device) => !device.archived)
        .map((device) => device.device_id),
    );
    for (const source of snapshot.sources) {
      if (
        !source.run ||
        source.run.scopeEpoch !== scope ||
        source.trackingValidity !== "valid"
      )
        continue;
      const run = source.run;
      if (!devices.has(run.deviceId)) continue;
      for (const association of source.associations) {
        const key = JSON.stringify([
          scope,
          run.runId,
          association.mediaGeneration,
          association.trackId,
        ]);
        const entry = entries.get(key) ?? createEntry(key, association);
        if (!entry || entry.terminalChecked) continue;
        const previous = entry.activity.record.data.attribution.current;
        if (
          previous.kind !== "known" ||
          !isDeepStrictEqual(previous.association, association)
        )
          accept(entry, {
            kind: "known",
            association,
            acceptedAt: Date.now(),
          });
      }
    }
    for (const [key, entry] of entries) {
      const data = entry.activity.record.data;
      const source = snapshot.sources.find(
        (item) => item.run?.runId === data.run.runId,
      );
      const track =
        source?.tracking?.mediaTime.generation === data.mediaGeneration &&
        source.tracking.tracks.some((item) => item.trackId === data.trackId);
      if (!track && !entry.terminalChecked) {
        entry.endingAt ??= Date.now();
        // Appearance owns human terminal certification. Pet/direct-only paths use raw recent.
        const appearanceTarget = perception.appearance?.target(key);
        if (!appearanceTarget) {
          const recent =
            source?.identity?.mediaTime.generation === data.mediaGeneration
              ? source.identity.recent.find(
                  (item) => item.trackId === data.trackId,
                )
              : undefined;
          if (recent || Date.now() - entry.endingAt >= 60_000)
            end(
              key,
              entry,
              recent?.endedAt ?? null,
              recent?.lastSeenAt ?? null,
            );
        }
      } else if (track) entry.endingAt = null;
      schedule(key, entry);
      release(key, entry);
    }
  }
  const unsubscribePerception = perception.subscribe(collect);
  const unsubscribeHousehold = household.subscribe(collect);
  const timer = setInterval(collect, 1000);
  collect();
  return {
    close(signal: AbortSignal) {
      if (closing) return closing;
      collect();
      closed = true;
      clearInterval(timer);
      unsubscribePerception();
      unsubscribeHousehold();
      unsubscribeAppearance?.();
      closing = (async () => {
        try {
          await pTimeout(Promise.all(writes), {
            milliseconds: Infinity,
            signal,
          });
          signal.throwIfAborted();
          for (const [key, entry] of entries) schedule(key, entry, true);
          await pTimeout(Promise.all(writes), {
            milliseconds: Infinity,
            signal,
          });
        } finally {
          retireEntries();
        }
      })();
      return closing;
    },
  };
}
