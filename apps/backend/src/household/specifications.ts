import { setTimeout as sleep } from "node:timers/promises";
import { MiotSpecClient } from "../mijia/protocols/micloud/spec";
import { safeMijiaError, isRecoverableMijiaError } from "../mijia/errors";
import type { MijiaService } from "../mijia/service";
import { householdLimits, jsonBytes } from "./config";
import { specSchema } from "@home-agent/api/household";

type Device = ReturnType<MijiaService["directoryCandidate"]>["devices"][number];
/** Family-owned metadata cache. Only active model/URN groups retain tasks or results. */
export class HouseholdSpecifications {
  private groups = new Map<
    string,
    {
      devices: Device[];
      controller: AbortController;
      running: boolean;
      result: ReturnType<typeof specSchema.parse> | null;
      done: boolean;
    }
  >();
  private active = 0;
  constructor(
    private readonly changed: () => void,
    private readonly capacity: (specBytes: number) => boolean,
  ) {}
  update(devices: Device[], refresh = false) {
    if (refresh && [...this.groups.values()].some((group) => !group.done))
      refresh = false;
    const grouped = new Map<string, Device[]>();
    for (const device of devices) {
      const key = device.spec_type || device.model;
      grouped.set(key, [...(grouped.get(key) ?? []), device]);
    }
    for (const [key, group] of this.groups)
      if (!grouped.has(key)) {
        group.controller.abort();
        this.groups.delete(key);
      }
    for (const [key, items] of grouped) {
      const existing = this.groups.get(key);
      if (existing) {
        existing.devices = items;
        if (refresh && !existing.running) {
          existing.done = false;
          if (existing.result)
            existing.result = {
              ...existing.result,
              status: "loading",
              error: null,
            };
        }
      } else
        this.groups.set(key, {
          devices: items,
          controller: new AbortController(),
          running: false,
          result: null,
          done: false,
        });
    }
    this.pump();
  }
  snapshot() {
    const specs: Record<string, ReturnType<typeof specSchema.parse>> = {};
    const references = new Map<string, string>();
    for (const [key, group] of this.groups) {
      const result =
        group.result ??
        specSchema.parse({
          id: key,
          urn: group.devices[0]?.spec_type ?? "",
          version: group.devices[0]?.spec_type?.split(":").at(-1) ?? "",
          status: "loading",
          category: null,
          spec: {},
          error: null,
        });
      specs[result.id] = result;
      for (const device of group.devices) references.set(device.id, result.id);
    }
    return { specs, references };
  }
  clear() {
    for (const group of this.groups.values()) group.controller.abort();
    this.groups.clear();
  }
  private pump() {
    for (const [key, group] of this.groups) {
      if (this.active >= householdLimits.specConcurrency) break;
      if (group.running || group.done) continue;
      group.running = true;
      this.active++;
      void this.load(key, group).finally(() => {
        group.running = false;
        this.active--;
        this.pump();
      });
    }
  }
  private async load(
    key: string,
    group: NonNullable<ReturnType<typeof this.groups.get>>,
  ) {
    const device = group.devices[0]!;
    const signal = group.controller.signal;
    const client = new MiotSpecClient(householdLimits.directoryBytes);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await client.get(
          {
            did: device.id,
            model: device.model,
            ...(device.spec_type ? { spec_type: device.spec_type } : {}),
          },
          signal,
        );
        if (signal.aborted || this.groups.get(key) !== group) return;
        const previous = group.result;
        group.result = specSchema.parse({
          id: result.urn,
          urn: result.urn,
          version: result.urn.split(":").at(-1) ?? "",
          category: result.category,
          spec: result.spec,
          status: "ready",
          error: null,
        });
        if (!this.capacity(jsonBytes(this.snapshot().specs))) {
          group.result = previous;
          throw new Error("Specification exceeds household capacity");
        }
        group.done = true;
        this.changed();
        return;
      } catch (error) {
        if (signal.aborted || this.groups.get(key) !== group) return;
        const delay = householdLimits.specRetryMs[attempt];
        if (delay !== undefined && isRecoverableMijiaError(error)) {
          try {
            await sleep(delay, undefined, { signal });
          } catch {
            return;
          }
          continue;
        }
        group.result = specSchema.parse({
          id: key,
          urn: device.spec_type ?? "",
          version: device.spec_type?.split(":").at(-1) ?? "",
          category: null,
          spec: {},
          ...group.result,
          status: "error",
          error: safeMijiaError(error, "spec_failed").toPayload(),
        });
        group.done = true;
        this.changed();
        return;
      }
    }
  }
}
