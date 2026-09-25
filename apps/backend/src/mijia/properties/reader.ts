import { z } from "zod";
import { MiCloudError, type MiCloud } from "../protocols/micloud";
import {
  miotPropertyAddressSchema,
  type MiotPropertyAddress,
} from "../protocols/micloud/properties";
import { miotCloudCacheProfile } from "./source-profiles";

const responseRowSchema = miotPropertyAddressSchema.extend({
  code: z.unknown().optional(),
  value: z.unknown().optional(),
});
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

type ReadOutcome =
  | ReturnType<typeof classifyRow>
  | ReturnType<typeof requestFailure>;

export type PropertyReadObservation = ReturnType<
  typeof propertyObservations
>[number];

type RetryGate = {
  until: number;
  receivedAt: string;
  outcome: ReturnType<typeof requestFailure>;
};

export type PropertyReadContext = {
  client: MiCloud;
  source_id: string;
  collection_generation: string;
  assertCurrent: () => void;
};

function propertyKey(property: MiotPropertyAddress) {
  return JSON.stringify([property.did, property.siid, property.piid]);
}

function classifyRow(row: z.infer<typeof responseRowSchema>) {
  // MiLoCo result_codes.py accepts these two negative status codes; Xiaomi's
  // SDK error table names them OK/accept. A value must still be present and valid.
  const code =
    typeof row.code === "number" && Number.isFinite(row.code)
      ? row.code
      : undefined;
  if (
    code !== undefined &&
    Number.isInteger(code) &&
    code < 0 &&
    code !== -702000000 &&
    code !== -702010000
  )
    return { status: "failure" as const, code };

  const resultCode = code === undefined ? {} : { code };
  if (!Object.hasOwn(row, "value"))
    return {
      status: "unavailable" as const,
      reason: "value_missing" as const,
      ...resultCode,
    };
  const value = scalarSchema.safeParse(row.value);
  if (!value.success)
    return {
      status: "unavailable" as const,
      reason: "invalid_value" as const,
      ...resultCode,
    };
  return { status: "success" as const, value: value.data, ...resultCode };
}

function requestFailure(error: MiCloudError) {
  return {
    status: "unavailable" as const,
    reason: "request_failed" as const,
    error: {
      kind: error.code,
      ...(error.httpStatus === undefined
        ? {}
        : { http_status: error.httpStatus }),
      ...(error.upstreamCode === undefined
        ? {}
        : { upstream_code: error.upstreamCode }),
      ...(error.retryAfterAt === undefined
        ? {}
        : { retry_after_at: new Date(error.retryAfterAt).toISOString() }),
    },
  };
}

function propertyObservations(
  batch: readonly MiotPropertyAddress[],
  context: PropertyReadContext,
  read_started_at: string | null,
  received_at: string,
  outcomes: ReadonlyMap<string, ReadOutcome>,
) {
  return batch.map((property) => ({
    ...property,
    contract_id: miotCloudCacheProfile.contract_id,
    contract_version: miotCloudCacheProfile.contract_version,
    source_id: context.source_id,
    collection_generation: context.collection_generation,
    delivery_kind: miotCloudCacheProfile.read.delivery_kind,
    read_semantics: miotCloudCacheProfile.read.read_semantics,
    observed_at: miotCloudCacheProfile.read.observed_at,
    read_started_at,
    received_at,
    ...(outcomes.get(propertyKey(property)) ?? {
      status: "unavailable" as const,
      reason: "response_missing" as const,
    }),
  }));
}

/** One owner shares one serial HTTP budget across every read invocation. */
export class PropertyReader {
  private tail: Promise<void> = Promise.resolve();
  // Source identity survives credential renewal; new credentials do not bypass rate limits.
  private readonly retryGates = new Map<string, RetryGate>();

  async read(
    properties: readonly MiotPropertyAddress[],
    context: PropertyReadContext,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    context.assertCurrent();
    const requested = properties.map(({ did, siid, piid }) => ({
      did,
      siid,
      piid,
    }));
    const observations: PropertyReadObservation[] = [];
    for (
      let offset = 0;
      offset < requested.length;
      offset += miotCloudCacheProfile.read.max_batch_size
    ) {
      const batch = requested.slice(
        offset,
        offset + miotCloudCacheProfile.read.max_batch_size,
      );
      const batchObservations = await this.enqueue(
        () => this.readBatch(batch, context, signal),
        signal,
      );
      observations.push(...batchObservations);
      const unauthorized = batchObservations.find(
        (item) =>
          item.status === "unavailable" &&
          item.reason === "request_failed" &&
          item.error.kind === "authentication",
      );
      if (unauthorized) {
        for (const property of requested.slice(offset + batch.length))
          observations.push({
            ...unauthorized,
            ...property,
            read_started_at: null,
          });
        break;
      }
    }
    signal.throwIfAborted();
    context.assertCurrent();
    return observations;
  }

  private enqueue<T>(run: () => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    const operation = this.tail.then(() => {
      signal.throwIfAborted();
      return run();
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    // Cancel the caller immediately, while retaining the in-flight operation's
    // budget until its transport has actually stopped.
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }

  private async readBatch(
    batch: MiotPropertyAddress[],
    context: PropertyReadContext,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    context.assertCurrent();
    // Check after entering the shared queue: an earlier batch may have just set the gate.
    const gate = this.retryGates.get(context.source_id);
    if (gate && gate.until > Date.now()) {
      const outcome = {
        ...gate.outcome,
        error: { ...gate.outcome.error },
      };
      return propertyObservations(
        batch,
        context,
        null,
        gate.receivedAt,
        new Map(batch.map((property) => [propertyKey(property), outcome])),
      );
    }
    if (gate) this.retryGates.delete(context.source_id);
    let read_started_at: string | null = null;
    let received_at: string;
    const outcomes = new Map<string, ReadOutcome>();
    try {
      const rows = await context.client.getProperties(
        batch,
        signal,
        (startedAt) => {
          read_started_at = startedAt;
        },
      );
      received_at = new Date().toISOString();
      signal.throwIfAborted();
      context.assertCurrent();
      const requestedKeys = new Set(batch.map(propertyKey));
      for (const row of rows) {
        const parsed = responseRowSchema.safeParse(row);
        if (!parsed.success) continue;
        const key = propertyKey(parsed.data);
        if (!requestedKeys.has(key)) continue;
        const previous = outcomes.get(key);
        const outcome = classifyRow(parsed.data);
        // A repeated failure or malformed row cannot erase an accepted value.
        if (
          !previous ||
          (previous.status !== "success" && outcome.status === "success") ||
          (previous.status === "unavailable" && outcome.status === "failure")
        )
          outcomes.set(key, outcome);
      }
    } catch (error) {
      signal.throwIfAborted();
      context.assertCurrent();
      if (!(error instanceof MiCloudError) || error.code === "cancelled")
        throw error;
      received_at = new Date().toISOString();
      const failure = requestFailure(error);
      const now = Date.now();
      if (error.retryAfterAt !== undefined && error.retryAfterAt > now) {
        for (const [source, previous] of this.retryGates)
          if (previous.until <= now) this.retryGates.delete(source);
        this.retryGates.set(context.source_id, {
          until: error.retryAfterAt,
          receivedAt: received_at,
          outcome: { ...failure, error: { ...failure.error } },
        });
      }
      for (const property of batch)
        outcomes.set(propertyKey(property), failure);
    }
    signal.throwIfAborted();
    context.assertCurrent();
    return propertyObservations(
      batch,
      context,
      read_started_at,
      received_at,
      outcomes,
    );
  }
}
