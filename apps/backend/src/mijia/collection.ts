import type { CollectionSource } from "../household/collection";
import type { MijiaService } from "./service";
import { subscribableDevice } from "./protocols/miot/messages";

/** All topic decoding and vendor read outcomes stay at the integration boundary. */
export function createMijiaCollectionSource(service: MijiaService) {
  return {
    supports: subscribableDevice,
    observe: async (id, receive, signal) =>
      service.observeDevices(
        [id],
        (event) => {
          if (event.kind === "directory") return;
          if (event.kind === "subscription") {
            const match =
              /^device\/([^/]+)\/(up\/properties_changed|state)\/#$/.exec(
                event.topic,
              );
            if (!match) return;
            receive({
              ...event,
              did: match[1]!,
              channel: match[2] === "state" ? "online" : "properties",
            });
          } else receive(event);
        },
        signal,
      ),
    read: async (properties, signal) =>
      (await service.readProperties(properties, signal)).map((result) => ({
        property: { did: result.did, siid: result.siid, piid: result.piid },
        observation:
          result.status === "success"
            ? { ...result, kind: "read" as const }
            : null,
        reason:
          result.status === "success"
            ? null
            : result.status === "failure"
              ? `device_code_${result.code}`
              : result.reason,
      })),
  } satisfies CollectionSource;
}
