import type { z } from "zod";
import type { PerceptionSources } from "../perception/sources";
import { sourceKey, type sourceSelectionSchema } from "../perception/config";
import type { HouseholdRuntime } from "../household/runtime";
import type { MijiaService } from "./service";

function cameraAccess(
  snapshot: ReturnType<HouseholdRuntime["snapshot"]>,
  ready: boolean,
) {
  const { scope_epoch, projection } = snapshot;
  const authorized =
    ready && projection.account.account.status === "authenticated";
  const cameras = authorized
    ? Object.values(projection.device).filter((device) => device.camera)
    : [];
  return {
    scopeEpoch: scope_epoch,
    devices: projection.device,
    accountStatus: projection.account.account.status,
    ready,
    sources: new Map(
      cameras.flatMap((device) =>
        device.channels.map((channel) => {
          const source = { deviceId: device.id, channel };
          return [
            sourceKey(source),
            {
              source,
              online: device.online,
              access: {
                scopeEpoch: scope_epoch,
                identity: JSON.stringify([
                  scope_epoch,
                  device.id,
                  device.model,
                  device.channels,
                ]),
              },
            },
          ] as const;
        }),
      ),
    ),
  };
}

export function createPerceptionSources(
  household: HouseholdRuntime,
  mijia: MijiaService,
) {
  let current = cameraAccess(household.snapshot(), household.ready);
  function accessSnapshot() {
    const snapshot = household.snapshot();
    const ready = household.ready;
    if (
      snapshot.projection.device !== current.devices ||
      snapshot.projection.account.account.status !== current.accountStatus ||
      snapshot.scope_epoch !== current.scopeEpoch ||
      ready !== current.ready
    )
      current = cameraAccess(snapshot, ready);
    return current.sources;
  }
  function eligibility(source: z.infer<typeof sourceSelectionSchema>) {
    const access = accessSnapshot().get(sourceKey(source))?.access;
    return access ? { ...access, householdVersion: household.version() } : null;
  }
  return {
    list() {
      return [...accessSnapshot().values()].map(({ source }) => ({
        ...source,
      }));
    },
    eligibility,
    subscribe(
      listener: (version: ReturnType<HouseholdRuntime["version"]>) => void,
    ) {
      const notify = () => listener(household.version());
      const stopHousehold = household.subscribe(notify);
      const stopMijia = mijia.subscribe(notify);
      notify();
      return () => {
        stopHousehold();
        stopMijia();
      };
    },
    async prepare(
      source: z.infer<typeof sourceSelectionSchema>,
      signal: AbortSignal,
    ) {
      const granted = eligibility(source);
      if (!granted) throw new Error("Camera access unavailable");
      const identity = granted.identity;
      signal.throwIfAborted();
      const key = sourceKey(source);
      if (
        !accessSnapshot().get(key)?.online ||
        mijia.sourceSnapshot().binding.status !== "ready"
      )
        await new Promise<void>((resolve, reject) => {
          const stopHousehold = household.subscribe(check);
          const stopMijia = mijia.subscribe(check);
          signal.addEventListener("abort", check, { once: true });

          function finish(settle: () => void) {
            stopHousehold();
            stopMijia();
            signal.removeEventListener("abort", check);
            settle();
          }

          function check() {
            if (signal.aborted) return finish(() => reject(signal.reason));
            const available = accessSnapshot().get(key);
            if (available?.access.identity !== identity)
              return finish(() => reject(new Error("Camera access retired")));
            if (
              available.online &&
              mijia.sourceSnapshot().binding.status === "ready"
            )
              finish(resolve);
          }

          check();
        });
      const media = mijia.sourceSnapshot();
      if (media.binding.status !== "ready")
        throw new Error("Camera media connection unavailable");
      const prepared = await mijia.prepareAnalysis(
        media.revision,
        source.deviceId,
        source.channel,
        signal,
        source.videoQuality,
      );
      signal.throwIfAborted();
      if (eligibility(source)?.identity !== identity)
        throw new Error("Camera access retired");
      return prepared;
    },
  } satisfies PerceptionSources;
}
