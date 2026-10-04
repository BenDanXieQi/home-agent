import PQueue from "p-queue";
import { isDeepStrictEqual } from "node:util";
import {
  memberActivityAttributionSchema,
  attributionTriggerSchema,
  type memberAttributionSnapshotSchema,
} from "@home-agent/api/contracts";
import type { z } from "zod";
import type { HouseholdRuntime } from "../runtime";
import type { createPerceptionService } from "../../perception/service";
import type { createMemberActivityRepository } from "./activity-repository";
import { createMemberAccess } from "../members/access";
import { HouseholdError } from "../errors";
import {
  memberActivity,
  activityReferenceIds,
  activitySupportVersions,
} from "./activity";

function pendingActivity(activity: ReturnType<typeof memberActivity>) {
  return {
    activity,
    savedRevision: 0,
    savedCorrectionCount: 0,
    savedAt: 0,
    savedState: "",
    queued: false,
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
    "snapshot" | "subscribe" | "appearance" | "referenceVersions"
  >,
  repository: ReturnType<typeof createMemberActivityRepository>,
) {
  const access = createMemberAccess(household);
  const queue = new PQueue({ concurrency: 1 });
  const writes = new Set<Promise<void>>();
  const entries = new Map<string, ReturnType<typeof pendingActivity>>();
  // Current and frozen in-flight dependencies survive successful writes.
  const dependents = new Map<string, Set<string>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let capacityWarningAt = 0;
  let scope = household.snapshot().scope_epoch;
  let referenceVersions = perception.referenceVersions();
  function dependencies() {
    dependents.clear();
    for (const [key, entry] of entries) {
      for (const id of [
        ...activityReferenceIds(entry.activity.record.data.attribution.current),
        ...activityReferenceIds(
          entry.inFlight?.activity.record.data.attribution.current ??
            entry.activity.record.data.attribution.current,
        ),
      ]) {
        const keys = dependents.get(id) ?? new Set<string>();
        keys.add(key);
        dependents.set(id, keys);
      }
    }
  }
  function discard(entry: ReturnType<typeof pendingActivity>) {
    if (entry.activity.record.data.attribution.current.kind !== "known") return;
    entry.suspended = true;
    entry.discardedRevision = entry.activity.record.data.attribution.revision;
  }
  function eligible(entry: ReturnType<typeof pendingActivity>) {
    const current = entry.activity.record.data.attribution.current;
    return (
      !entry.suspended &&
      (current.kind === "unknown" ||
        activitySupportVersions(current).every((version) =>
          isDeepStrictEqual(version, perception.referenceVersions()),
        ))
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
    const writing = queue
      .add(async () => {
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
            (activity.record.data.attribution.current.kind === "known" &&
              activitySupportVersions(
                activity.record.data.attribution.current,
              ).some(
                (version) =>
                  !isDeepStrictEqual(version, perception.referenceVersions()),
              ))
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
      })
      .catch((error: unknown) => {
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
    if (next.kind === "unknown") reason = "reference_revoked";
    else if (
      before.kind === "unknown" ||
      before.association.memberId !== next.association.memberId
    )
      reason = "member_changed";
    else if (
      before.association.basis === "appearance" &&
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
    if (event.kind === "reference_revoked") {
      const keys = new Set(
        event.referenceIds.flatMap((id) => [...(dependents.get(id) ?? [])]),
      );
      for (const key of keys) {
        const entry = entries.get(key);
        if (!entry) continue;
        if (
          entry.inFlight &&
          activityReferenceIds(
            entry.inFlight.activity.record.data.attribution.current,
          ).some((id) =>
            event.referenceIds.some((referenceId) => referenceId === id),
          )
        )
          entry.inFlight.revoked = true;
        const ids = activityReferenceIds(
          entry.activity.record.data.attribution.current,
        ).filter((id) =>
          event.referenceIds.some((referenceId) => referenceId === id),
        );
        if (ids.length) {
          const trigger = attributionTriggerSchema.parse({
            ...event,
            referenceIds: ids,
            references: event.references.filter((reference) =>
              ids.includes(reference.referenceId),
            ),
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
        if (event.reason === "reference_versions_changed") {
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
      entries.clear();
      dependencies();
      scope = householdState.scope_epoch;
    }
    if (!household.ready) return;
    const versions = perception.referenceVersions();
    if (!isDeepStrictEqual(versions, referenceVersions)) {
      referenceVersions = versions;
      for (const entry of entries.values()) {
        discard(entry);
        if (
          entry.inFlight?.activity.record.data.attribution.current.kind ===
          "known"
        )
          entry.inFlight.revoked = true;
      }
    }
    const snapshot = perception.snapshot();
    const devices = new Map(
      Object.values(householdState.projection.device)
        .filter((device) => !device.archived)
        .map((device) => [device.device_id, device]),
    );
    const rooms = new Map(
      Object.values(householdState.projection.room)
        .filter((room) => !room.archived)
        .map((room) => [room.room_id, room]),
    );
    for (const source of snapshot.sources) {
      if (
        !source.run ||
        source.run.scopeEpoch !== scope ||
        source.trackingValidity !== "valid"
      )
        continue;
      const run = source.run;
      const device = devices.get(run.deviceId);
      if (!device) continue;
      for (const association of source.associations) {
        const key = JSON.stringify([
          scope,
          run.runId,
          association.mediaGeneration,
          association.trackId,
        ]);
        let entry = entries.get(key);
        if (entry?.terminalChecked) continue;
        if (!entry && entries.size >= 256) {
          if (Date.now() >= capacityWarningAt) {
            console.error("Member activity capacity reached");
            capacityWarningAt = Date.now() + 5000;
          }
          continue;
        }
        const current = {
          kind: "known" as const,
          association,
          acceptedAt: Date.now(),
        };
        if (!entry) {
          const attribution = memberActivityAttributionSchema.parse({
            original: current,
            current,
            revision: 1,
            correctionCount: 0,
            lastCorrection: null,
          });
          entry = pendingActivity(
            memberActivity(crypto.randomUUID(), {
              run,
              mediaGeneration: association.mediaGeneration,
              trackId: association.trackId,
              sourceRunId: run.runId,
              deviceId: run.deviceId,
              channel: run.channel,
              deviceName: device.alias || device.name,
              cameraRoomName: device.room_id
                ? (rooms.get(device.room_id)?.name ?? null)
                : null,
              firstObservedAt: association.observedAt,
              lastObservedAt: association.observedAt,
              endedAt: null,
              timeBasis: "host_received_at",
              attribution,
            }),
          );
          entries.set(key, entry);
          dependencies();
        } else {
          const previous = entry.activity.record.data.attribution.current;
          if (
            previous.kind !== "known" ||
            !isDeepStrictEqual(previous.association, association)
          )
            accept(entry, current);
        }
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
    close() {
      if (closing) return closing;
      collect();
      closed = true;
      clearInterval(timer);
      unsubscribePerception();
      unsubscribeHousehold();
      unsubscribeAppearance?.();
      closing = (async () => {
        await Promise.all(writes);
        for (const [key, entry] of entries) schedule(key, entry, true);
        await Promise.all(writes);
        entries.clear();
        dependents.clear();
      })();
      return closing;
    },
  };
}
