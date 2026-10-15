import type { MijiaService } from "../service";
import type { accessHousehold } from "../../household/access";
import type { createMaterialStorage } from "./storage";
import { RetryTimer } from "../retry-timer";
import { subscribableDevice } from "../protocols/miot/messages";
import { accessMaterialDevice } from "./access";
import { failure, success, type CollectorDiagnostic } from "./diagnostics";

type Scope = ReturnType<typeof accessHousehold>;
export function createMaterialEventSubscriptions(deps: {
  mijia: MijiaService;
  signal: AbortSignal;
  state: (
    collector: string,
    scope: string,
    deviceId?: string,
  ) => CollectorDiagnostic;
  save: ReturnType<typeof createMaterialStorage>;
}) {
  const { signal } = deps;
  const watches = new Map<string, AbortController>();
  function clear() {
    const removed = [...watches.values()];
    watches.clear();
    for (const watch of removed) watch.abort();
  }
  function reconcile(valid: ReadonlySet<string>) {
    for (const [did, watch] of watches)
      if (!valid.has(did)) {
        watches.delete(did);
        watch.abort();
      }
  }
  function observeDeviceEvents(scope: Scope) {
    const session = deps.mijia.materialSession(signal);
    const devices = session.devices();
    const valid = new Set(devices.map((device) => device.did));
    reconcile(valid);
    for (const device of devices) {
      if (watches.has(device.did) || !subscribableDevice(device.did)) continue;
      const watch = new AbortController();
      watches.set(device.did, watch);
      const diagnostic = deps.state("miot_event", device.did, device.did);
      let connectionGeneration: string | undefined;
      let connected = false;
      let binding:
        | Awaited<ReturnType<MijiaService["observeDeviceEvents"]>>
        | undefined;
      const retry = new RetryTimer();
      watch.signal.addEventListener(
        "abort",
        () => {
          retry.cancel();
        },
        { once: true },
      );
      const isCurrent = () =>
        !signal.aborted &&
        !watch.signal.aborted &&
        watches.get(device.did) === watch;
      const retrySubscription = () => {
        if (!isCurrent()) return;
        retry.schedule(() => {
          if (!isCurrent()) return;
          if (!binding) {
            retrySubscription();
            return;
          }
          try {
            diagnostic.last_attempt_at = new Date().toISOString();
            binding.retry();
          } catch (error) {
            failure(diagnostic, error);
            watches.delete(device.did);
            watch.abort();
          }
        });
      };
      diagnostic.last_attempt_at = new Date().toISOString();
      deps.mijia
        .observeDeviceEvents(
          [device.did],
          (event) => {
            if (!isCurrent()) return;
            if (event.kind === "subscription") {
              connectionGeneration = event.collection_generation;
              if (event.status === "confirmed") connected = true;
              else if (
                event.status === "failed" ||
                event.status === "cancelled"
              )
                connected = false;
              if (
                event.status === "cancelled" &&
                watches.get(device.did) === watch
              ) {
                watches.delete(device.did);
                watch.abort();
              }
              diagnostic.status =
                event.status === "confirmed"
                  ? "ready"
                  : event.status === "failed"
                    ? event.reason === "subscription_rejected"
                      ? "subscription_rejected"
                      : "temporarily_failed"
                    : "not_attempted";
              if (
                event.status === "confirmed" ||
                event.reason === "subscription_rejected"
              )
                retry.cancel();
              else if (
                event.status === "failed" &&
                event.reason === "subscribe_failed"
              )
                retrySubscription();
              diagnostic.error = event.reason;
              diagnostic.suspended = event.reason === "subscription_rejected";
              diagnostic.limitations = [
                "subscription_confirmation_is_not_event_receipt",
              ];
            } else if (event.kind === "event") {
              let access: ReturnType<typeof accessMaterialDevice>;
              try {
                scope.assertCurrent();
                access = accessMaterialDevice(
                  deps.mijia,
                  scope,
                  event.did,
                  signal,
                );
              } catch {
                return;
              }
              const currentDevice = access.device;
              let specification:
                | ReturnType<MijiaService["getDeviceSpec"]>
                | undefined;
              try {
                specification = deps.mijia.getDeviceSpec(event.did, signal);
              } catch {}
              const capability =
                specification?.spec[`event.${event.siid}.${event.eiid}`];
              const generation = event.collection_generation;
              diagnostic.records_received++;
              deps
                .save(
                  access.scope,
                  {
                    topic: "miot_event",
                    account_id: scope.identity.accountId,
                    home_id: scope.identity.homeId,
                    device_id: event.did,
                    room_id: currentDevice.room_id ?? null,
                    model: currentDevice.model ?? null,
                    source: {
                      ...event.source_metadata,
                      specification: currentDevice.spec_type ?? null,
                    },
                    siid: event.siid,
                    eiid: event.eiid,
                    name: capability?.description ?? null,
                    arguments: event.arguments.map((argument) => ({
                      ...argument,
                      description:
                        specification?.spec[
                          `prop.${event.siid}.${argument.piid}`
                        ]?.description ?? null,
                    })),
                  },
                  event.received_at,
                )
                .then((saved) => {
                  if (!isCurrent()) return;
                  if (saved.inserted) diagnostic.records_saved++;
                  else diagnostic.records_repeated++;
                  if (connected && generation === connectionGeneration)
                    success(diagnostic, diagnostic.records_received, [
                      "provider_event_identity_not_verified",
                    ]);
                  else diagnostic.last_success_at = new Date().toISOString();
                })
                .catch((error: unknown) => {
                  if (
                    !isCurrent() ||
                    !connected ||
                    generation !== connectionGeneration
                  )
                    return;
                  failure(diagnostic, error);
                });
            } else if (event.kind === "connection") {
              connectionGeneration = event.collection_generation;
              connected = event.status === "connected";
              if (event.status === "closed") {
                diagnostic.status = "temporarily_failed";
                diagnostic.error = event.reason;
              }
            }
          },
          AbortSignal.any([signal, watch.signal]),
        )
        .then((value) => {
          if (!isCurrent()) {
            value.cancel();
            return;
          }
          binding = value;
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          failure(diagnostic, error);
          if (watches.get(device.did) === watch) watches.delete(device.did);
          watch.abort();
        });
    }
  }
  return { observe: observeDeviceEvents, reconcile, clear };
}
