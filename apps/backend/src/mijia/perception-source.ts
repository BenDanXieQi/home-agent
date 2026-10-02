import type { z } from "zod";
import type { PerceptionSources } from "../perception/sources";
import { sourceKey, type sourceSelectionSchema } from "../perception/config";
import type { HouseholdRuntime } from "../household/runtime";
import type { MijiaService } from "./service";

function cameraAccess(
  snapshot: ReturnType<HouseholdRuntime["snapshot"]>,
  ready: boolean,
) {
  const { scope_epoch, sequence, projection } = snapshot;
  // Discovery health does not revoke the committed household or its devices.
  const authorized =
    ready && projection.account.account.status === "authenticated";
  const householdVersion = { scope_epoch, sequence };
  const cameras = authorized
    ? Object.values(projection.device).filter((device) => device.camera)
    : [];
  return {
    snapshot,
    ready,
    sources: new Map(
      cameras.flatMap((device) =>
        device.channels.map((channel) => {
          const source = { deviceId: device.id, channel };
          return [
            sourceKey(source),
            {
              source,
              access: {
                scopeEpoch: scope_epoch,
                householdVersion,
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

// Authorization is projected from the committed household, never from a raw cloud catalog.
export function createPerceptionSources(
  household: HouseholdRuntime,
  mijia: MijiaService,
) {
  let current = cameraAccess(household.snapshot(), household.ready);
  function accessSnapshot() {
    const snapshot = household.snapshot();
    const ready = household.ready;
    // The committed projection is immutable. All windows for a source reuse its
    // grant until the household changes; every access still checks the current state.
    if (
      snapshot.projection !== current.snapshot.projection ||
      snapshot.scope_epoch !== current.snapshot.scope_epoch ||
      snapshot.sequence !== current.snapshot.sequence ||
      ready !== current.ready
    )
      current = cameraAccess(snapshot, ready);
    return current.sources;
  }
  function eligibility(source: z.infer<typeof sourceSelectionSchema>) {
    return accessSnapshot().get(sourceKey(source))?.access ?? null;
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
      // A media connection owns only the live capture lease. Restarting it must
      // not revoke clips that still belong to the current household and device.
      const media = mijia.sourceSnapshot();
      if (media.binding.status !== "ready")
        throw new Error("Camera media connection unavailable");
      const prepared = await mijia.prepareAnalysis(
        media.revision,
        source.deviceId,
        source.channel,
        signal,
      );
      signal.throwIfAborted();
      if (eligibility(source)?.identity !== granted.identity)
        throw new Error("Camera access retired");
      return prepared;
    },
  } satisfies PerceptionSources;
}
