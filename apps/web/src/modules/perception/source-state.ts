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
export function createPerceptionSourceState({
  deviceId,
  channel,
}: Pick<
  ConstructorParameters<typeof PlaybackSession>[0],
  "deviceId" | "channel"
>) {
  const target = { deviceId, channel };
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
    identityUnavailableMessageAtom: atom((get) => {
      if (!get(connectedAtom)) return "正在同步成员身份分析状态…";
      if (!get(accessibleAtom)) return "当前摄像头已不可访问，成员关联已清空。";
      const snapshot = get(perceptionSnapshotAtom);
      if (snapshot?.status === "unavailable")
        return `后台分析不可用${snapshot.error ? `：${snapshot.error}` : "。"}`;
      if (snapshot?.resources?.identityThreads === 0)
        return "成员身份分析未启用。";
      const source = get(sourceAtom);
      if (!source) return "当前摄像头未配置后台分析。";
      if (source.status === "failed" || source.status === "unavailable")
        return `当前来源不可用${source.error ? `：${source.error}` : "。"}`;
      if (!get(activeSourceAtom)) return "当前来源运行尚未就绪，等待后台同步。";
      if (source.identityValidity === "expired")
        return "成员身份分析结果已过期，等待更新。";
      if (source.identityValidity === "unavailable")
        return "成员身份分析暂不可用，等待后台恢复。";
      if (!source.identity || source.identityValidity === "no_data")
        return "成员身份分析已启用，等待首个分析结果。";
      if (source.identity.run.runId !== source.run?.runId)
        return "来源运行已切换，等待本次运行的身份分析结果。";
      return null;
    }),
    identityAtom: atom((get) => {
      const source = get(activeSourceAtom);
      if (
        !source ||
        source.identityValidity !== "valid" ||
        source.identity?.run.runId !== source.run?.runId
      )
        return null;
      return source.identity;
    }),
    audioAtom,
    playbackTargetAtom,
    configuredAtom: atom((get) => !!get(sourceAtom)),
    errorAtom: atom((get) => get(sourceAtom)?.error),
  };
}
