import { atom } from "jotai";
import type { perceptionSnapshotSchema } from "@home-agent/api/contracts";
import { devicesAtom } from "../devices/state";
import {
  householdScopeEpochAtom,
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
  const sourceAtom =
    atom<
      ReturnType<typeof perceptionSnapshotSchema.parse>["sources"][number]
    >();
  const connectedAtom = atom(false);
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
    return get(connectedAtom) &&
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
