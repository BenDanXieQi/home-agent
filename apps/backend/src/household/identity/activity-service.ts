import PQueue from "p-queue";
import { isDeepStrictEqual } from "node:util";
import type { HouseholdRuntime } from "../runtime";
import type { createPerceptionService } from "../../perception/service";
import type { createMemberActivityRepository } from "./activity-repository";
import { createMemberAccess } from "../members/access";
import { HouseholdError } from "../errors";
import { memberActivity } from "./activity";

function pendingActivity(
  activity: NonNullable<ReturnType<typeof memberActivity>>,
) {
  return {
    activity,
    saved: undefined as typeof activity | undefined,
    queued: false,
    active: true,
    retryAt: 0,
  };
}

// Observe accepted associations independently of browser viewing and window filtering.
export function createMemberActivityService(
  household: HouseholdRuntime,
  perception: Pick<
    ReturnType<typeof createPerceptionService>,
    "snapshot" | "subscribe"
  >,
  repository: ReturnType<typeof createMemberActivityRepository>,
) {
  const access = createMemberAccess(household);
  const queue = new PQueue({ concurrency: 1 });
  const writes = new Set<Promise<void>>();
  const entries = new Map<string, ReturnType<typeof pendingActivity>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let capacityWarningAt = 0;
  let scope = household.snapshot().scope_epoch;
  function signature(activity: ReturnType<typeof pendingActivity>["activity"]) {
    return `${activity.record.certainty}:${activity.record.data.state}:${Math.floor(activity.record.data.lastObservedAt / 10_000)}`;
  }
  function schedule(
    key: string,
    entry: ReturnType<typeof pendingActivity>,
    final = false,
  ) {
    if (
      entry.queued ||
      (!final && entry.retryAt > Date.now()) ||
      (entry.saved && isDeepStrictEqual(entry.saved, entry.activity))
    )
      return;
    if (
      !final &&
      entry.active &&
      entry.saved &&
      signature(entry.saved) === signature(entry.activity)
    )
      return;
    entry.queued = true;
    const writing = queue
      .add(async () => {
        if (entries.get(key) !== entry) return;
        const activity = entry.activity;
        const context = access(activity.record.scopeEpoch);
        const assertCurrent = () => {
          context.assertCurrent();
          if (entries.get(key) !== entry)
            throw new HouseholdError("stale_session");
        };
        const accepted = await repository.save(
          context.identity,
          assertCurrent,
          activity,
        );
        if (!accepted) {
          if (entries.get(key) === entry) entries.delete(key);
          return;
        }
        entry.saved = activity;
        entry.retryAt = 0;
      })
      .catch((error: unknown) => {
        if (error instanceof HouseholdError && error.reason === "stale_session")
          return;
        entry.retryAt = Date.now() + 5000;
        console.error("Member activity storage failed", error);
      })
      .finally(() => {
        writes.delete(writing);
        entry.queued = false;
        if (
          !entry.active &&
          entry.saved &&
          isDeepStrictEqual(entry.saved, entry.activity) &&
          entries.get(key) === entry
        )
          entries.delete(key);
      });
    writes.add(writing);
  }
  function collect() {
    if (closed) return;
    const householdState = household.snapshot();
    if (householdState.scope_epoch !== scope) {
      entries.clear();
      scope = householdState.scope_epoch;
    }
    if (!household.ready) return;
    const snapshot = perception.snapshot();
    const sources = new Map(
      snapshot.sources.map((source) => [source.run?.runId, source]),
    );
    // A live track alone cannot retain an obsolete member, media generation or reference version.
    for (const [key, entry] of entries) {
      const data = entry.activity.record.data;
      const source = sources.get(data.sourceRunId);
      entry.active =
        !!source &&
        source.run?.scopeEpoch === scope &&
        source.trackingValidity === "valid" &&
        source.tracking?.mediaTime.generation ===
          entry.activity.record.evidence[0]?.provenance.mediaGeneration &&
        isDeepStrictEqual(
          source.identity?.referenceVersions,
          data.referenceVersions,
        ) &&
        !!source.tracking?.tracks.some(
          (track) => track.trackId === data.trackId,
        ) &&
        !source.identity?.associations.some(
          (association) =>
            association.trackId === data.trackId &&
            association.memberId !== data.memberId,
        );
      if (
        !entry.active &&
        !entry.queued &&
        entry.saved &&
        isDeepStrictEqual(entry.saved, entry.activity)
      )
        entries.delete(key);
    }
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
        source.identityValidity !== "valid" ||
        source.trackingValidity !== "valid" ||
        !source.identity
      )
        continue;
      const run = source.run;
      const device = devices.get(run.deviceId);
      if (!device) continue;
      for (const association of source.identity.associations) {
        const key = JSON.stringify([
          scope,
          run.runId,
          association.trackId,
          association.memberId,
          source.identity.mediaTime.generation,
          source.identity.referenceVersions,
        ]);
        let entry = entries.get(key);
        if (!entry && entries.size >= 256) {
          if (Date.now() >= capacityWarningAt) {
            console.error("Member activity pending capacity reached");
            capacityWarningAt = Date.now() + 5000;
          }
          continue;
        }
        const activity = memberActivity({
          id: entry?.activity.record.id ?? crypto.randomUUID(),
          firstObservedAt:
            entry?.activity.record.data.firstObservedAt ??
            association.observedAt,
          deviceId: run.deviceId,
          channel: run.channel,
          deviceName: device.alias || device.name,
          cameraRoomName: device.room_id
            ? (rooms.get(device.room_id)?.name ?? null)
            : null,
          observation: source.identity,
          association,
        });
        if (!activity) continue;
        if (!entry) {
          entry = pendingActivity(activity);
          entries.set(key, entry);
        } else {
          entry.activity = activity;
          entry.active = true;
        }
      }
    }
    for (const [key, entry] of entries) schedule(key, entry);
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
      closing = (async () => {
        await Promise.all(writes);
        for (const [key, entry] of entries) schedule(key, entry, true);
        await Promise.all(writes);
        entries.clear();
      })();
      return closing;
    },
  };
}
