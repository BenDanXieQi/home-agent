import type { z } from "zod";
import type { PerceptionSources } from "../perception/sources";
import type { sourceSelectionSchema } from "../perception/config";
import type { HouseholdRuntime } from "../household/runtime";
import type { MijiaService } from "./service";

// Authorization is projected from the committed household, never from a raw cloud catalog.
export function createPerceptionSources(
  household: HouseholdRuntime,
  mijia: MijiaService,
) {
  function householdReady() {
    const snapshot = household.snapshot();
    return (
      household.ready &&
      snapshot.projection.account.account.status === "authenticated" &&
      snapshot.projection.household.household.sync_status === "synced"
    );
  }
  function eligibility(source: z.infer<typeof sourceSelectionSchema>) {
    const { scope_epoch, projection } = household.snapshot();
    const device = Object.values(projection.device).find(
      (candidate) => candidate.id === source.deviceId,
    );
    const media = mijia.sourceSnapshot();
    if (
      !householdReady() ||
      !device?.camera ||
      !device.channels.includes(source.channel) ||
      media.binding.status !== "ready"
    )
      return null;
    return {
      scopeEpoch: scope_epoch,
      householdVersion: household.version(),
      revision: media.revision,
      identity: JSON.stringify([
        scope_epoch,
        media.revision,
        device.model,
        device.channels,
      ]),
    };
  }
  return {
    list() {
      if (!householdReady()) return [];
      return Object.values(household.snapshot().projection.device)
        .filter((device) => device.camera)
        .flatMap((device) =>
          device.channels.map((channel) => ({ deviceId: device.id, channel })),
        );
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
      const prepared = await mijia.prepareAnalysis(
        granted.revision,
        source.deviceId,
        source.channel,
        signal,
      );
      signal.throwIfAborted();
      if (eligibility(source)?.identity !== granted.identity)
        throw new Error("Camera access retired");
      return { ...prepared, scopeEpoch: granted.scopeEpoch };
    },
  } satisfies PerceptionSources;
}
