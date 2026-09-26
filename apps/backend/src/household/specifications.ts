import { setTimeout as sleep } from "node:timers/promises";
import { MiotSpecClient } from "../mijia/protocols/micloud/spec";
import { safeMijiaError, isRecoverableMijiaError } from "../mijia/errors";
import type { deviceDirectory } from "../mijia/devices/directory";
import { householdLimits, jsonBytes } from "./config";
import { specSchema } from "@home-agent/api/household";

type Device = ReturnType<typeof deviceDirectory>["devices"][number];
/** Family-owned metadata cache. Only active model/URN groups retain tasks or results. */
export class HouseholdSpecifications {
  private readonly client = new MiotSpecClient(householdLimits.directoryBytes);
  private readonly aliases = new Map<string, string>();
  private readonly groups = new Map<
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
    const sources = new Map<string, Device[]>();
    for (const device of devices) {
      const key = device.spec_type || device.model;
      const source = sources.get(key);
      if (source) source.push(device);
      else sources.set(key, [device]);
    }
    for (const key of this.aliases.keys())
      if (!sources.has(key)) this.aliases.delete(key);

    // Refresh completed groups independently. Resolve their models again so a
    // changed model-to-URN mapping can split previously shared specifications.
    const previous = new Map<
      string,
      NonNullable<ReturnType<typeof this.groups.get>>["result"]
    >();
    const grouped = new Map<string, Device[]>();
    for (const [source, items] of sources) {
      const group = this.groups.get(this.aliases.get(source) ?? source);
      if (refresh && group?.done && !group.running) {
        previous.set(source, group.result);
        this.aliases.delete(source);
      }
      const key = this.aliases.get(source) ?? source;
      const groupedDevices = grouped.get(key);
      if (groupedDevices) for (const item of items) groupedDevices.push(item);
      else grouped.set(key, [...items]);
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
      } else {
        const result = previous.get(key);
        this.groups.set(key, {
          devices: items,
          controller: new AbortController(),
          running: false,
          result: result ? { ...result, status: "loading", error: null } : null,
          done: false,
        });
      }
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
    this.aliases.clear();
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
    let deviceUrn = device.spec_type;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted || group.done || this.groups.get(key) !== group)
        return;
      try {
        const resolved = await this.client.resolve(
          {
            model: device.model,
            ...(deviceUrn ? { spec_type: deviceUrn } : {}),
          },
          signal,
        );
        if (signal.aborted || group.done || this.groups.get(key) !== group)
          return;
        deviceUrn = resolved.urn;
        const shared = this.groups.get(deviceUrn);
        if (shared?.result?.status === "ready") {
          this.commit(key, group, shared.result);
          return;
        }
        const result = await this.client.read(resolved, signal);
        if (signal.aborted || group.done || this.groups.get(key) !== group)
          return;
        this.commit(
          key,
          group,
          specSchema.parse({
            id: result.urn,
            urn: result.urn,
            version: result.urn.split(":").at(-1) ?? "",
            category: result.category,
            spec: result.spec,
            status: "ready",
            error: null,
          }),
        );
        return;
      } catch (error) {
        if (signal.aborted || group.done || this.groups.get(key) !== group)
          return;
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
          urn: deviceUrn ?? "",
          version: deviceUrn?.split(":").at(-1) ?? "",
          category: null,
          spec: {},
          ...group.result,
          id: key,
          status: "error",
          error: safeMijiaError(error, "spec_failed").toPayload(),
        });
        group.done = true;
        this.changed();
        return;
      }
    }
  }
  private commit(
    key: string,
    group: NonNullable<ReturnType<typeof this.groups.get>>,
    result: ReturnType<typeof specSchema.parse>,
  ) {
    const owner = this.groups.get(result.urn) ?? group;
    const previous = group.result;
    const previousOwner = owner.result;
    const accepted = owner.result?.status === "ready" ? owner.result : result;
    group.result = accepted;
    owner.result = accepted;
    if (!this.capacity(jsonBytes(this.snapshot().specs))) {
      group.result = previous;
      owner.result = previousOwner;
      throw new Error("Specification exceeds household capacity");
    }
    group.done = true;
    owner.done = true;
    for (const device of group.devices)
      this.aliases.set(device.spec_type || device.model, result.urn);
    if (owner !== group) {
      for (const device of group.devices) owner.devices.push(device);
      group.controller.abort();
    }
    if (key !== result.urn) {
      this.groups.delete(key);
      this.groups.set(result.urn, owner);
    }
    this.changed();
  }
}
