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
  const audioAtom = atom((get) => {
    const source = get(sourceAtom);
    const snapshot = get(perceptionSnapshotAtom);
    const access = get(perceptionSourceAccessAtom);
    const removed = access.removed.get(`${target.deviceId}:${target.channel}`);
    // Audio owns its run independently of video compute. The synchronized
    // snapshot confirms household access; a pre-removal snapshot cannot restore it.
    if (
      !get(connectedAtom) ||
      !get(accessibleAtom) ||
      !source ||
      !snapshot?.householdVersion ||
      (access.epoch === snapshot.householdVersion.scope_epoch &&
        removed !== undefined &&
        snapshot.householdVersion.sequence <= removed)
    )
      return null;
    const { audio } = snapshot;
    return {
      status: audio.status,
      error: audio.error,
      track:
        audio.tracks.find(
          (track) =>
            track.run.trackRunId === source.audioTrackRunId &&
            track.run.scopeEpoch === get(householdScopeEpochAtom) &&
            track.run.deviceId === target.deviceId &&
            track.channels.includes(target.channel),
        ) ?? null,
    };
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
    audioAtom,
    playbackTargetAtom,
    configuredAtom: atom((get) => !!get(sourceAtom)),
    errorAtom: atom((get) => get(sourceAtom)?.error),
  };
}
