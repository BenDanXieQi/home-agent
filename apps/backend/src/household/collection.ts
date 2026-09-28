import { entityKey, type Projection } from "@home-agent/api/household";
import {
  householdObservationSchema,
  propertyKey,
  type HouseholdObservation,
  propertyAddressSchema,
  propertyReadItemSchema,
} from "@home-agent/api/observations";
import type { z } from "zod";
import {
  collectionLimits,
  defaultCollectionPolicy,
  propertyPolicy,
} from "./collection-policy";
import type { HouseholdRuntime } from "./runtime";
import type { FactInput, PropertyDefinition } from "./observations";
import { HouseholdError } from "./errors";
import { jsonBytes } from "./config";

type Address = z.infer<typeof propertyAddressSchema>;

function createPropertyRead(
  epoch: string,
  property: Address,
  deviceKey: string,
  signature: string,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(collectionLimits.readTimeoutMs),
  ]);
  const { promise, resolve } =
    Promise.withResolvers<z.infer<typeof propertyReadItemSchema>>();
  return {
    controller,
    signal,
    promise,
    resolve,
    consumers: new Set<object>(),
    deviceKey,
    signature,
    epoch,
    property,
  };
}
export type CollectionSource = {
  supports: (id: string) => boolean;
  observe: (
    id: string,
    receive: (event: HouseholdObservation) => void,
    signal: AbortSignal,
  ) => Promise<{ cancel: () => void; retry: () => void }>;
  read: (
    properties: Address[],
    signal: AbortSignal,
  ) => Promise<
    {
      property: Address;
      observation: Extract<HouseholdObservation, { kind: "read" }> | null;
      reason: string | null;
    }[]
  >;
};

/** Owns subscriptions, bounded input work and reads; current facts belong to the actor. */
export class HouseholdCollection {
  private scope = "";
  private devices: Projection["device"] | undefined;
  private synced = false;
  private syncing = false;
  private paused = false;
  private watches = new Map<
    string,
    {
      signature: string;
      controller: AbortController;
      watch?: Awaited<ReturnType<CollectionSource["observe"]>>;
      failures: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private queue: { input: FactInput; bytes: number }[] = [];
  private queuedBytes = 0;
  private turnProcessed = 0;
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private overloads: number[] = [];
  private samples: { at: string; kind: string; reason: string }[] = [];
  private inFlight = new Map<string, ReturnType<typeof createPropertyRead>>();
  private readQueue: ReturnType<typeof createPropertyRead>[] = [];
  private reading = 0;
  private seeding = false;
  private seedScheduled = false;
  private seeded = new Map<
    string,
    { signature: string; properties: Set<string> }
  >();
  private lastClock = { wall: Date.now(), tick: performance.now() };

  constructor(
    private readonly runtime: HouseholdRuntime,
    private readonly source: CollectionSource,
    private readonly policy = defaultCollectionPolicy,
  ) {}

  scheduleSync() {
    if (this.synced) return;
    this.synced = true;
    queueMicrotask(() => {
      this.synced = false;
      this.sync();
    });
  }
  private sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const snapshot = this.runtime.snapshot();
      if (
        !this.runtime.ready ||
        snapshot.projection.account.account.status !== "authenticated"
      ) {
        this.reset();
        return;
      }
      if (this.scope !== snapshot.scope_epoch) {
        this.reset();
        this.scope = snapshot.scope_epoch;
      }
      if (this.paused) return;
      const devices = snapshot.projection.device;
      if (this.devices !== devices) {
        const definitions: PropertyDefinition[] = [];
        const supported: string[] = [];
        for (const device of Object.values(devices)) {
          if (device.archived) continue;
          if (this.source.supports(device.id)) supported.push(device.id);
          try {
            for (const key of Object.keys(
              this.runtime.specification(device.id).spec,
            )) {
              const match = /^prop\.(\d+)\.(\d+)$/.exec(key);
              if (match)
                definitions.push(
                  this.definition(device, Number(match[1]), Number(match[2])),
                );
            }
          } catch {
            /* Unavailable specifications do not stop observations. */
          }
        }
        for (const [id, binding] of this.watches) {
          const device = Object.values(devices).find((item) => item.id === id);
          if (!device || binding.signature !== this.signature(device)) {
            binding.controller.abort();
            clearTimeout(binding.timer);
            this.watches.delete(id);
            this.seeded.delete(id);
          }
        }
        for (const [key, read] of this.inFlight)
          if (
            !devices[read.deviceKey] ||
            this.signature(devices[read.deviceKey]!) !== read.signature
          ) {
            read.controller.abort();
            this.inFlight.delete(key);
          }
        this.runtime.commitFacts(this.scope, {
          kind: "configure",
          definitions,
          supported,
          policy_version: this.policy.version,
        });
        this.devices = this.runtime.snapshot().projection.device;
        for (const device of Object.values(this.devices)) {
          if (
            device.archived ||
            !this.source.supports(device.id) ||
            this.watches.has(device.id)
          )
            continue;
          const binding = {
            signature: this.signature(device),
            controller: new AbortController(),
            failures: 0,
          };
          this.watches.set(device.id, binding);
          void this.observe(device.id, binding);
        }
        // Specifications can finish after the initial subscription confirmation.
        for (const id of this.watches.keys()) this.seedRead(id);
      }
      this.armExpiry();
    } finally {
      this.syncing = false;
    }
  }
  private signature(device: Projection["device"][string]) {
    return JSON.stringify([device.model, device.spec_id]);
  }
  private definition(
    device: Projection["device"][string],
    siid: number,
    piid: number,
  ) {
    let capability: PropertyDefinition["capability"];
    try {
      capability = this.runtime.specification(device.id).spec[
        `prop.${siid}.${piid}`
      ];
    } catch {
      /* Raw observations remain visible without a specification. */
    }
    return {
      device,
      siid,
      piid,
      capability,
      policy: propertyPolicy(
        this.policy,
        device.model,
        device.spec_id,
        siid,
        piid,
      ),
      policy_version: this.policy.version,
    };
  }
  private async observe(
    id: string,
    binding: NonNullable<ReturnType<typeof this.watches.get>>,
  ) {
    const epoch = this.scope;
    try {
      const watch = await this.source.observe(
        id,
        (event) => {
          if (
            binding.controller.signal.aborted ||
            this.scope !== epoch ||
            this.watches.get(id) !== binding
          )
            return;
          this.receive(event);
        },
        binding.controller.signal,
      );
      if (binding.controller.signal.aborted || this.scope !== epoch) {
        watch.cancel();
        return;
      }
      binding.watch = watch;
      this.runtime.commitFacts(epoch, {
        kind: "status",
        status: "running",
        reason: null,
      });
      this.seedRead(id);
    } catch {
      if (binding.controller.signal.aborted || epoch !== this.scope) return;
      binding.failures++;
      this.runtime.commitFacts(epoch, {
        kind: "status",
        status: "error",
        reason: "observe_failed",
      });
      if (binding.failures <= 2) {
        binding.timer = setTimeout(() => {
          void this.observe(id, binding);
        }, binding.failures * 2000);
        binding.timer.unref();
      }
    }
  }
  private receive(raw: HouseholdObservation) {
    const parsed = householdObservationSchema.safeParse(raw);
    if (
      !parsed.success ||
      ("packet_bytes" in raw &&
        raw.packet_bytes > collectionLimits.messageBytes)
    ) {
      this.gap("invalid_observation", 1);
      return;
    }
    const event = parsed.data;
    const current = this.runtime.snapshot().projection;
    if (event.kind === "connection") {
      const old = current.source_health[event.source_id];
      if (
        old?.collection_generation === event.collection_generation &&
        old.status === event.status &&
        old.updated_at === event.received_at
      )
        return;
    }
    const clock = { wall: Date.now(), tick: performance.now() };
    if (
      Math.abs(
        clock.wall - this.lastClock.wall - (clock.tick - this.lastClock.tick),
      ) > 5000
    )
      this.gap("clock_changed", this.queue.length);
    this.lastClock = clock;
    if (this.paused) return;
    const lost =
      (event.kind === "connection" && event.status !== "connected") ||
      (event.kind === "subscription" && event.status !== "confirmed");
    if (lost) {
      const kept = this.queue.filter(
        ({ input }) =>
          input.kind !== "observe" ||
          input.event.source_id !== event.source_id ||
          (event.kind === "subscription" &&
            "did" in input.event &&
            input.event.did !== event.did),
      );
      const dropped = this.queue.length - kept.length;
      this.queue = kept;
      this.queuedBytes = kept.reduce((sum, item) => sum + item.bytes, 0);
      if (dropped)
        this.runtime.commitFacts(this.scope, {
          kind: "gap",
          reason: "coverage_lost",
          dropped,
          paused: false,
          at: event.received_at,
        });
      this.apply({
        kind: "observe",
        event,
        definition: undefined,
        observation_id: crypto.randomUUID(),
        tick: clock.tick,
      });
      return;
    }
    const device =
      "did" in event
        ? current.device[
            entityKey(current.household.household.account_id ?? "", event.did)
          ]
        : undefined;
    const definition =
      device && (event.kind === "property" || event.kind === "read")
        ? this.definition(device, event.siid, event.piid)
        : undefined;
    this.enqueue({
      kind: "observe",
      event,
      definition,
      observation_id: crypto.randomUUID(),
      tick: clock.tick,
    });
  }
  private enqueue(input: FactInput) {
    const bytes = jsonBytes(input);
    if (
      this.queue.length >= collectionLimits.queued ||
      this.queuedBytes + bytes > collectionLimits.queuedBytes
    ) {
      this.gap("overload", this.queue.length + 1);
      return;
    }
    this.queue.push({ input, bytes });
    this.queuedBytes += bytes;
    if (!this.immediate && this.turnProcessed < collectionLimits.batch)
      this.drain();
    else if (!this.immediate)
      this.immediate = setImmediate(() => {
        this.turnProcessed = 0;
        this.drain();
      });
  }
  private drain() {
    this.immediate = undefined;
    const batch = this.queue.splice(
      0,
      Math.max(1, collectionLimits.batch - this.turnProcessed),
    );
    this.turnProcessed += batch.length;
    for (const item of batch) {
      this.queuedBytes -= item.bytes;
      if (!this.scope || this.paused || this.runtime.epoch !== this.scope)
        break;
      this.apply(item.input);
    }
    if (this.queue.length || this.turnProcessed >= collectionLimits.batch)
      this.immediate = setImmediate(() => {
        this.turnProcessed = 0;
        this.drain();
      });
    this.armExpiry();
  }
  private apply(input: FactInput) {
    if (!this.scope || this.runtime.epoch !== this.scope || !this.runtime.ready)
      return;
    const before = this.runtime.snapshot().projection;
    if (
      input.kind === "observe" &&
      (input.event.kind === "property" || input.event.kind === "read")
    ) {
      const device =
        before.device[
          entityKey(
            before.household.household.account_id ?? "",
            input.event.did,
          )
        ];
      if (
        !device ||
        device.spec_id !== input.definition?.device.spec_id ||
        device.model !== input.definition.device.model
      )
        return;
      input = {
        ...input,
        definition: this.definition(device, input.event.siid, input.event.piid),
      };
    }
    const receipt = this.runtime.commitFacts(this.scope, input);
    if (receipt?.outcome === "failed")
      this.sample(input.kind, receipt.reason ?? "rejected");
    if (input.kind === "observe") {
      const event = input.event;
      if (
        event.kind === "subscription" &&
        event.channel === "properties" &&
        event.status === "confirmed"
      )
        this.seedRead(event.did);
      if (event.kind === "online" && event.online) {
        const key = entityKey(
          before.household.household.account_id ?? "",
          event.did,
        );
        if (
          before.device[key]?.availability !== "online" &&
          this.runtime.snapshot().projection.device[key]?.availability ===
            "online"
        )
          this.seedRead(event.did, true);
      }
    }
  }
  private armExpiry() {
    clearTimeout(this.expiry);
    if (!this.scope || this.paused) return;
    const deadline = this.runtime.factDeadline();
    if (!Number.isFinite(deadline)) return;
    this.expiry = setTimeout(
      () =>
        this.enqueue({
          kind: "expire",
          tick: performance.now(),
          at: new Date().toISOString(),
        }),
      Math.max(1, deadline - performance.now()),
    );
    this.expiry.unref();
  }
  private gap(reason: string, dropped: number) {
    this.queue = [];
    this.queuedBytes = 0;
    clearImmediate(this.immediate);
    this.immediate = undefined;
    const now = performance.now();
    this.overloads = this.overloads.filter(
      (tick) => now - tick < collectionLimits.overloadWindowMs,
    );
    if (reason === "overload") this.overloads.push(now);
    this.paused = this.overloads.length >= collectionLimits.overloadLimit;
    this.runtime.commitFacts(this.scope, {
      kind: "gap",
      reason,
      dropped,
      paused: this.paused,
      at: new Date().toISOString(),
    });
    this.sample("gap", reason);
    if (this.paused) clearTimeout(this.expiry);
    if (this.paused)
      for (const binding of this.watches.values()) {
        binding.controller.abort();
        clearTimeout(binding.timer);
      }
  }
  private sample(kind: string, reason: string) {
    this.samples.push({ at: new Date().toISOString(), kind, reason });
    while (
      this.samples.length > collectionLimits.samples ||
      jsonBytes(this.samples) > collectionLimits.sampleBytes
    )
      this.samples.shift();
  }
  private seedRead(id: string, online = false) {
    if (!this.scope || this.paused) return;
    const projection = this.runtime.snapshot().projection;
    const device =
      projection.device[
        entityKey(projection.household.household.account_id ?? "", id)
      ];
    if (!device || device.availability === "offline") return;
    const coverage =
      projection.device_coverage[entityKey(device.account_id, id)];
    if (coverage?.properties !== "confirmed") return;
    const signature = JSON.stringify([
      this.signature(device),
      coverage.collection_generation,
    ]);
    let seeded = this.seeded.get(id);
    if (!seeded || seeded.signature !== signature || online) {
      seeded = { signature, properties: new Set<string>() };
      this.seeded.set(id, seeded);
    }
    this.scheduleSeedReads();
  }
  private scheduleSeedReads() {
    if (this.seedScheduled) return;
    this.seedScheduled = true;
    queueMicrotask(() => {
      this.seedScheduled = false;
      this.pumpSeedReads();
    });
  }
  private pumpSeedReads() {
    if (this.seeding || !this.scope || this.paused || !this.runtime.ready)
      return;
    const available = Math.min(
      collectionLimits.readBatch,
      collectionLimits.readPending - this.inFlight.size,
    );
    if (available <= 0) return;
    const projection = this.runtime.snapshot().projection;
    const pending: {
      property: Address;
      signal: AbortSignal;
    }[] = [];
    for (const device of Object.values(projection.device)) {
      if (pending.length >= available) break;
      const seed = this.seeded.get(device.id);
      const binding = this.watches.get(device.id);
      const coverage =
        projection.device_coverage[entityKey(device.account_id, device.id)];
      if (
        !seed ||
        !binding ||
        binding.controller.signal.aborted ||
        device.archived ||
        device.availability === "offline" ||
        coverage?.properties !== "confirmed" ||
        seed.signature !==
          JSON.stringify([
            this.signature(device),
            coverage.collection_generation,
          ])
      )
        continue;
      for (const property of device.read_enabled_properties) {
        if (pending.length >= available) break;
        const key = propertyKey(
          device.account_id,
          device.id,
          property.siid,
          property.piid,
        );
        if (
          seed.properties.has(key) ||
          projection.latest[key]?.quality === "valid"
        )
          continue;
        seed.properties.add(key);
        pending.push({
          property: { did: device.id, ...property },
          signal: binding.controller.signal,
        });
      }
    }
    if (!pending.length) return;
    this.seeding = true;
    const epoch = this.scope;
    void Promise.allSettled(
      pending.map(({ property, signal }) =>
        this.readOne(epoch, property, signal),
      ),
    ).then((results) => {
      if (epoch === this.scope)
        for (const result of results)
          if (
            result.status === "fulfilled" &&
            result.value.outcome === "failed"
          )
            this.sample("initial_read", result.value.reason ?? "read_failed");
      this.seeding = false;
      this.scheduleSeedReads();
    });
  }
  async read(epoch: string, properties: Address[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (epoch !== this.runtime.epoch || !this.runtime.ready)
      throw new HouseholdError("stale_session");
    return Promise.all(
      properties.map((property) => this.readOne(epoch, property, signal)),
    );
  }
  private readOne(epoch: string, property: Address, signal: AbortSignal) {
    const projection = this.runtime.snapshot().projection;
    const deviceKey = entityKey(
      projection.household.household.account_id ?? "",
      property.did,
    );
    const device = projection.device[deviceKey];
    const failed = (reason: string) => ({
      ...property,
      outcome: "failed" as const,
      quality: "unknown" as const,
      reason,
      observation_id: null,
    });
    if (!device || device.archived)
      return Promise.resolve(failed("device_not_found"));
    if (device.availability === "offline")
      return Promise.resolve(failed("offline"));
    const definition = this.definition(device, property.siid, property.piid);
    if (!definition.capability?.readable)
      return Promise.resolve(failed("property_not_readable"));
    const key = propertyKey(
      device.account_id,
      property.did,
      property.siid,
      property.piid,
    );
    let task = this.inFlight.get(key);
    if (!task) {
      if (this.inFlight.size >= collectionLimits.readPending)
        return Promise.resolve(failed("read_capacity"));
      task = this.startRead(epoch, property, deviceKey, this.signature(device));
      this.inFlight.set(key, task);
      const active = task;
      void task.promise
        .finally(() => {
          if (this.inFlight.get(key) === active) this.inFlight.delete(key);
          this.scheduleSeedReads();
        })
        .catch(() => {});
    }
    const active = task;
    const consumer = {};
    active.consumers.add(consumer);
    return new Promise<z.infer<typeof propertyReadItemSchema>>(
      (resolve, reject) => {
        const detach = () => {
          signal.removeEventListener("abort", abort);
          active.consumers.delete(consumer);
          if (!active.consumers.size) active.controller.abort();
        };
        const abort = () => {
          detach();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        active.promise.then(
          (value) => {
            detach();
            resolve(value);
          },
          (error: unknown) => {
            detach();
            reject(error);
          },
        );
        if (signal.aborted) abort();
      },
    );
  }
  private startRead(
    epoch: string,
    property: Address,
    deviceKey: string,
    signature: string,
  ) {
    const task = createPropertyRead(epoch, property, deviceKey, signature);
    const { controller, signal, promise } = task;
    const abort = () => {
      this.readQueue = this.readQueue.filter((item) => item !== task);
      this.failRead(
        task,
        controller.signal.aborted ? "cancelled" : "read_timeout",
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.finally(() => signal.removeEventListener("abort", abort));
    this.readQueue.push(task);
    queueMicrotask(() => this.pumpReads());
    return task;
  }
  private failRead(
    task: ReturnType<typeof createPropertyRead>,
    reason: string,
  ) {
    task.resolve({
      ...task.property,
      outcome: "failed",
      quality: "unknown",
      reason,
      observation_id: null,
    });
  }
  private readDevice(task: ReturnType<typeof createPropertyRead>) {
    task.signal.throwIfAborted();
    const device = this.runtime.snapshot().projection.device[task.deviceKey];
    if (
      task.epoch !== this.runtime.epoch ||
      !this.runtime.ready ||
      !device ||
      device.archived ||
      this.signature(device) !== task.signature
    )
      throw new HouseholdError("stale_session");
    return device;
  }
  private async readBatch(tasks: ReturnType<typeof createPropertyRead>[]) {
    const active = tasks.filter((task) => {
      try {
        this.readDevice(task);
        return true;
      } catch {
        this.failRead(task, "stale_session");
        return false;
      }
    });
    if (!active.length) return;
    const controller = new AbortController();
    const cancel = () => {
      if (active.every((task) => task.signal.aborted)) controller.abort();
    };
    for (const task of active) task.signal.addEventListener("abort", cancel);
    try {
      const results = await this.source.read(
        active.map((task) => task.property),
        controller.signal,
      );
      // Commit pushes received during the read before considering any cloud cache.
      while (this.queue.length) {
        await new Promise<void>((done) => setImmediate(done));
        controller.signal.throwIfAborted();
      }
      const byProperty = new Map(
        results.map((result) => [
          propertyKey(
            "",
            result.property.did,
            result.property.siid,
            result.property.piid,
          ),
          result,
        ]),
      );
      for (const task of active) {
        try {
          const device = this.readDevice(task);
          const { property } = task;
          const result = byProperty.get(
            propertyKey("", property.did, property.siid, property.piid),
          );
          if (!result?.observation) {
            this.failRead(task, result?.reason ?? "read_failed");
            continue;
          }
          const receipt = this.runtime.commitFacts(task.epoch, {
            kind: "observe",
            event: result.observation,
            definition: this.definition(device, property.siid, property.piid),
            observation_id: crypto.randomUUID(),
            tick: performance.now(),
          });
          if (receipt) task.resolve({ ...property, ...receipt });
          else this.failRead(task, "stale_session");
        } catch {
          this.failRead(task, "stale_session");
        }
      }
    } catch {
      for (const task of active) this.failRead(task, "read_failed");
    } finally {
      for (const task of active)
        task.signal.removeEventListener("abort", cancel);
    }
  }
  private pumpReads() {
    while (
      this.reading < collectionLimits.readConcurrent &&
      this.readQueue.length
    ) {
      const tasks = this.readQueue.splice(0, collectionLimits.readBatch);
      this.reading++;
      void this.readBatch(tasks).finally(() => {
        this.reading--;
        this.pumpReads();
        this.scheduleSeedReads();
      });
    }
  }
  retry() {
    this.paused = false;
    this.overloads = [];
    this.seeded.clear();
    for (const [id, binding] of this.watches) {
      if (binding.controller.signal.aborted || !binding.watch) {
        binding.controller.abort();
        clearTimeout(binding.timer);
        this.watches.delete(id);
      } else binding.watch.retry();
    }
    this.devices = undefined;
    this.scheduleSync();
  }
  diagnostics() {
    return {
      queued: this.queue.length,
      queued_bytes: this.queuedBytes,
      watches: this.watches.size,
      reads: this.inFlight.size,
      read_batches: this.reading,
      initializing: this.seeding || this.seedScheduled,
      samples: this.samples,
    };
  }
  reset() {
    if (
      this.scope &&
      this.scope === this.runtime.epoch &&
      this.runtime.snapshot().projection.household.household.status !==
        "stopping"
    ) {
      this.runtime.commitFacts(this.scope, {
        kind: "gap",
        reason: "collection_stopped",
        dropped: this.queue.length,
        paused: false,
        at: new Date().toISOString(),
      });
      this.runtime.commitFacts(this.scope, {
        kind: "status",
        status: "idle",
        reason: "collection_stopped",
      });
    }
    for (const binding of this.watches.values()) {
      binding.controller.abort();
      clearTimeout(binding.timer);
    }
    for (const read of this.inFlight.values()) read.controller.abort();
    this.watches.clear();
    this.seeded.clear();
    this.inFlight.clear();
    clearTimeout(this.expiry);
    clearImmediate(this.immediate);
    this.immediate = undefined;
    this.scope = "";
    this.devices = undefined;
    this.queue = [];
    this.queuedBytes = 0;
    this.turnProcessed = 0;
    this.paused = false;
    this.overloads = [];
  }
}
