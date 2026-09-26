import { setTimeout as sleep } from "node:timers/promises";
import { specSchema, type Projection } from "@home-agent/api/household";
import { isImmutable, parseImmutable } from "@home-agent/api/immutable";
import { householdLimits, jsonBytes } from "./config";
import type { DirectoryCandidate } from "./directory";
import { HouseholdError } from "./errors";

type Spec = ReturnType<typeof specSchema.parse>;
type Preparation = Pick<
  Projection["device"][string],
  "spec_id" | "spec_status" | "spec_error"
>;
type Device = Pick<
  DirectoryCandidate["devices"][number],
  "id" | "model" | "spec_type"
>;
type Metadata = Pick<Spec, "urn" | "category" | "spec">;

const encodedSizes = new WeakMap<Spec, number>();

/** Count the JSON object without serializing unchanged, owned specifications again. */
export function specificationBytes(specs: Record<string, Spec>) {
  let bytes = 2;
  let count = 0;
  for (const [id, spec] of Object.entries(specs)) {
    let size = isImmutable(spec) ? encodedSizes.get(spec) : undefined;
    if (size === undefined) {
      size = jsonBytes(spec);
      if (isImmutable(spec)) encodedSizes.set(spec, size);
    }
    bytes += jsonBytes(id) + 1 + size;
    count++;
  }
  return bytes + Math.max(0, count - 1);
}

type Loader = {
  resolve: (
    device: Pick<Device, "model" | "spec_type">,
    signal: AbortSignal,
  ) => Promise<{
    urn: Spec["urn"];
    read: (signal: AbortSignal) => Promise<Metadata>;
  }>;
  failure: (error: unknown) => {
    error: NonNullable<Preparation["spec_error"]>;
    retryable: boolean;
  };
};

/** Owns accepted URN metadata separately from model resolution and refresh work. */
export class HouseholdSpecifications {
  private accepted = new Map<string, { result: Spec; refreshed: number }>();
  private bindings = new Map<
    string,
    { source: string; model: Device["model"]; urn: string | null }
  >();
  private sources = new Map<
    string,
    {
      device: Pick<Device, "model" | "spec_type">;
      controller: AbortController;
      running: boolean;
      done: boolean;
      status: Preparation["spec_status"];
      error: Preparation["spec_error"];
      resolvedUrn: string | null;
      round: number;
    }
  >();
  private active = 0;
  private round = 0;
  private batch: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(
    private readonly loader: Loader,
    private readonly changed: (deviceIds: ReadonlySet<string>) => void,
    private readonly capacity: (
      snapshot: ReturnType<HouseholdSpecifications["snapshot"]>,
    ) => boolean,
  ) {}

  update(devices: readonly Device[]) {
    const sources: typeof this.sources = new Map();
    const bindings: typeof this.bindings = new Map();
    for (const device of devices) {
      const key = device.spec_type || device.model;
      let source = sources.get(key) ?? this.sources.get(key);
      if (!source) {
        source = {
          device: { model: device.model, spec_type: device.spec_type },
          controller: new AbortController(),
          running: false,
          done: false,
          status: "loading",
          error: null,
          resolvedUrn: null,
          round: 0,
        };
      }
      sources.set(key, source);
      bindings.set(device.id, {
        source: key,
        model: device.model,
        urn: this.bindings.get(device.id)?.urn ?? null,
      });
    }
    for (const [key, source] of this.sources)
      if (!sources.has(key)) source.controller.abort();
    this.sources = sources;
    this.bindings = bindings;
    this.accepted = this.referencedMetadata(bindings);
    // Attaching shared metadata is a data commit, even when no HTTP read is needed.
    for (const binding of bindings.values()) {
      const source = sources.get(binding.source)!;
      if (source.status === "ready" && binding.urn !== source.resolvedUrn) {
        source.done = false;
        source.status = "loading";
        source.error = null;
      }
    }
    this.pump();
    this.finishBatch();
  }

  refresh() {
    if (this.batch) return this.batch.promise;
    const batch = Promise.withResolvers<void>();
    this.batch = batch;
    const round = ++this.round;
    for (const source of this.sources.values()) {
      if (!source.done || source.running) continue;
      source.done = false;
      source.status = "loading";
      source.error = null;
      source.round = round;
    }
    this.changed(new Set(this.bindings.keys()));
    this.pump();
    this.finishBatch();
    return batch.promise;
  }

  snapshot(deviceIds?: ReadonlySet<string>) {
    return this.snapshotFrom(
      this.sources,
      this.bindings,
      this.accepted,
      deviceIds,
    );
  }

  /** Display metadata can outlive the definition for which it was verified. */
  isApplicable(deviceId: Device["id"], model: Device["model"]) {
    const binding = this.bindings.get(deviceId);
    if (!binding || binding.model !== model || binding.urn === null)
      return false;
    return (
      this.sources.get(binding.source)?.resolvedUrn === binding.urn &&
      this.accepted.has(binding.urn)
    );
  }

  /** Revocation only removes references and work; it cannot fail a capacity check. */
  retain(deviceIds: ReadonlySet<string>) {
    const bindings = new Map(
      [...this.bindings].filter(([id]) => deviceIds.has(id)),
    );
    const needed = new Set(
      [...bindings.values()].map((binding) => binding.source),
    );
    for (const [key, source] of this.sources) {
      if (needed.has(key)) continue;
      source.controller.abort();
      this.sources.delete(key);
    }
    this.bindings = bindings;
    this.accepted = this.referencedMetadata(bindings);
    this.finishBatch();
  }

  private snapshotFrom(
    sources: typeof this.sources,
    bindings: typeof this.bindings,
    accepted: typeof this.accepted,
    deviceIds?: ReadonlySet<string>,
  ) {
    const specs: Record<string, Spec> = {};
    const references = new Map<string, Preparation>();
    for (const deviceId of deviceIds ?? bindings.keys()) {
      const binding = bindings.get(deviceId);
      if (!binding) continue;
      const source = sources.get(binding.source)!;
      const metadata = binding.urn
        ? accepted.get(binding.urn)?.result
        : undefined;
      if (metadata) specs[metadata.id] = metadata;
      references.set(deviceId, {
        spec_id: metadata?.id ?? null,
        spec_status: source.status,
        spec_error: source.error,
      });
    }
    return { specs, references };
  }

  private referencedMetadata(
    bindings: typeof this.bindings,
    accepted = this.accepted,
  ) {
    const urns = new Set([...bindings.values()].map((binding) => binding.urn));
    return new Map([...accepted].filter(([urn]) => urns.has(urn)));
  }

  private notifySource(key: string, urn?: string) {
    const devices = new Set<string>();
    for (const [id, binding] of this.bindings)
      if (binding.source === key || (urn !== undefined && binding.urn === urn))
        devices.add(id);
    this.changed(devices);
  }

  clear() {
    for (const source of this.sources.values()) source.controller.abort();
    this.sources.clear();
    this.bindings.clear();
    this.accepted.clear();
    this.finishBatch();
  }

  private finishBatch() {
    if (
      !this.batch ||
      [...this.sources.values()].some((source) => !source.done)
    )
      return;
    this.batch.resolve();
    this.batch = undefined;
  }

  private pump() {
    for (const [key, source] of this.sources) {
      if (this.active >= householdLimits.specConcurrency) break;
      if (source.running || source.done) continue;
      source.running = true;
      this.active++;
      void this.load(key, source).finally(() => {
        source.running = false;
        this.active--;
        this.pump();
        this.finishBatch();
      });
    }
  }

  private async load(
    key: string,
    source: NonNullable<ReturnType<typeof this.sources.get>>,
  ) {
    const signal = source.controller.signal;
    let urn = source.device.spec_type;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return;
      try {
        const resolved = await this.loader.resolve(
          { model: source.device.model, spec_type: urn },
          signal,
        );
        if (signal.aborted) return;
        urn = resolved.urn;
        source.resolvedUrn = resolved.urn;
        const shared = this.accepted.get(resolved.urn);
        const result =
          shared && shared.refreshed >= source.round
            ? shared.result
            : parseImmutable(specSchema, {
                ...(await resolved.read(signal)),
                id: resolved.urn,
                version: resolved.urn.split(":").at(-1) ?? "",
              });
        if (signal.aborted) return;
        this.commit(key, source, result);
        return;
      } catch (error) {
        if (signal.aborted) return;
        const failure = this.loader.failure(error);
        const delay = householdLimits.specRetryMs[attempt];
        if (delay !== undefined && failure.retryable) {
          try {
            await sleep(delay, undefined, { signal });
          } catch {
            return;
          }
          continue;
        }
        source.status = "error";
        source.error = failure.error;
        source.done = true;
        this.notifySource(key);
        return;
      }
    }
  }

  private commit(
    key: string,
    source: NonNullable<ReturnType<typeof this.sources.get>>,
    result: Spec,
  ) {
    const accepted = new Map(this.accepted);
    const current = accepted.get(result.urn);
    if (!current || current.refreshed < source.round)
      accepted.set(result.urn, { result, refreshed: source.round });
    const bindings = new Map(this.bindings);
    for (const [id, binding] of bindings)
      if (binding.source === key)
        bindings.set(id, { ...binding, urn: result.urn });
    const retained = this.referencedMetadata(bindings, accepted);
    const previous = {
      status: source.status,
      error: source.error,
    };
    source.status = "ready";
    source.error = null;
    if (!this.capacity(this.snapshotFrom(this.sources, bindings, retained))) {
      Object.assign(source, previous);
      throw new HouseholdError("capacity_exceeded");
    }
    this.accepted = retained;
    this.bindings = bindings;
    source.done = true;
    this.notifySource(key, result.urn);
  }
}
