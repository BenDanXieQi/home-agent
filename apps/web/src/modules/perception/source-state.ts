import { atom } from "jotai";
import { perceptionSourceAccessAtom } from "./source-access";
import { perceptionSnapshotAtom, perceptionSyncedAtom } from "./state";
import { devicesAtom } from "../devices/state";
import {
  householdScopeEpochAtom,
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../household/state";
import { canStartPlaybackAtom } from "../playback/access";
import { mediaStateAtom } from "../playback/state";
import type { PlaybackSession } from "../playback/session";

/** Each detail owns one source; high-frequency results never enter page render state. */
export function createPerceptionSourceState(
  target: Pick<
    ConstructorParameters<typeof PlaybackSession>[0],
    "deviceId" | "channel"
  >,
) {
  const sourceAtom = atom((get) =>
    get(perceptionSnapshotAtom)?.sources.find(
      (source) =>
        source.source.deviceId === target.deviceId &&
        source.source.channel === target.channel,
    ),
  );
  const connectedAtom = perceptionSyncedAtom;
  const deviceAtom = atom((get) =>
    get(devicesAtom).find((device) => device.id === target.deviceId),
  );
  const accessibleAtom = atom((get) => {
    const device = get(deviceAtom);
    return (
      get(householdSyncedAtom) &&
      !!device?.camera &&
      device.channels.includes(target.channel)
    );
  });
  const activeSourceAtom = atom((get) => {
    const source = get(sourceAtom);
    const access = get(perceptionSourceAccessAtom);
    const removed = access.removed.get(`${target.deviceId}:${target.channel}`);
    const authorized = source?.authorizedAt;
    return get(connectedAtom) &&
      !!authorized &&
      (removed === undefined ||
        access.epoch !== authorized.scope_epoch ||
        authorized.sequence > removed) &&
      get(accessibleAtom) &&
      source?.run?.scopeEpoch === get(householdScopeEpochAtom)
      ? source
      : undefined;
  });
  const playbackTargetAtom = atom((get) => {
    const scope_epoch = get(householdScopeEpochAtom);
    const revision = get(mediaStateAtom)?.revision;
    return get(accessibleAtom) &&
      get(canStartPlaybackAtom) &&
      scope_epoch &&
      revision
      ? { ...target, scope_epoch, revision }
      : null;
  });
  return {
    target,
    revokedAtom: atom((get) => {
      const household = get(householdSnapshotAtom);
      const device = get(deviceAtom);
      return (
        !!household &&
        get(householdSyncedAtom) &&
        (!device?.camera || !device.channels.includes(target.channel))
      );
    }),
    sourceAtom,
    connectedAtom,
    deviceAtom,
    accessibleAtom,
    activeSourceAtom,
    playbackTargetAtom,
    configuredAtom: atom((get) => !!get(sourceAtom)),
    errorAtom: atom((get) => get(sourceAtom)?.error),
  };
}
