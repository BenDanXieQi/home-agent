import { freeze } from "@home-agent/api/immutable";
import { receiptChanges } from "./receipt-changes";
import { agentContextPartsSchema } from "@home-agent/api/agent-context";
import type { z } from "zod";
import {
  agentReceiptPolicy,
  agentReceiptSummarySchema,
  type agentReceiptSchema,
  type agentReceiptQuerySchema,
} from "@home-agent/api/agent-receipts";

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Diagnostic history of accepted messages; bounded independently of current context. */
export function createReceiptJournal() {
  let journalId = crypto.randomUUID();
  let sequence = 0;
  let previousContextBytes = 0;
  let retainedBytes = 0;
  let evicted = 0;
  let sizes = new WeakMap<object, number>();
  function cachedBytes(value: object) {
    let bytes = sizes.get(value);
    if (bytes === undefined) {
      bytes = jsonBytes(value);
      sizes.set(value, bytes);
    }
    return bytes;
  }
  function recordMapBytes(records: Record<string, object>) {
    const cached = sizes.get(records);
    if (cached !== undefined) return cached;
    const entries = Object.entries(records);
    const bytes =
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce(
        (total, [key, value]) =>
          total + jsonBytes(key) + 1 + cachedBytes(value),
        0,
      );
    sizes.set(records, bytes);
    return bytes;
  }
  function contextBytes(
    context: z.infer<typeof agentReceiptSchema>["context"],
  ) {
    const device = context.parts.device_state;
    if (device?.status === "ready" && !sizes.has(device)) {
      const { latest, source_health, device_coverage, collection, online } =
        device.data;
      // Delta merges share unchanged records. Serialize only new records and metadata.
      const bytes =
        jsonBytes({
          ...device,
          data: {
            ...device.data,
            latest: {},
            source_health: {},
            device_coverage: {},
            collection: {},
            online: [],
          },
        }) +
        [latest, source_health, device_coverage, collection].reduce(
          (total, records) => total + recordMapBytes(records) - 2,
          0,
        ) +
        cachedBytes(online) -
        2;
      sizes.set(device, bytes);
    }
    const entries = Object.entries(context.parts).flatMap(([key, part]) =>
      part === undefined ? [] : [{ key, part }],
    );
    return (
      jsonBytes({
        ...context,
        parts: Object.fromEntries(entries.map(({ key }) => [key, null])),
      }) + entries.reduce((total, { part }) => total + cachedBytes(part) - 4, 0)
    );
  }
  const entries: {
    receipt: z.infer<typeof agentReceiptSchema>;
    summary: z.infer<typeof agentReceiptSummarySchema>;
    bytes: number;
  }[] = [];
  return {
    clear() {
      journalId = crypto.randomUUID();
      sequence = 0;
      previousContextBytes = 0;
      retainedBytes = 0;
      evicted = 0;
      sizes = new WeakMap();
      entries.length = 0;
    },
    append(
      input: Pick<
        z.infer<typeof agentReceiptSchema>,
        "message" | "context" | "received_at" | "synchronized"
      >,
      payloadBytes: number,
      previous: z.infer<typeof agentReceiptSchema>["context"] | null,
    ) {
      const currentBytes = contextBytes(input.context);
      const changes = receiptChanges(input, previous);
      const summary = freeze(
        agentReceiptSummarySchema.parse({
          ...input,
          changes,
          id: crypto.randomUUID(),
          sequence: ++sequence,
          kind: sequence === 1 ? "initial" : "update",
          parts: agentContextPartsSchema
            .keyof()
            .options.filter(
              (name) => input.message.data.parts[name] !== undefined,
            ),
          payload_bytes: payloadBytes,
          context_bytes: currentBytes,
          context_delta_bytes: currentBytes - previousContextBytes,
        }),
      );
      const receipt = { ...input, ...summary };
      previousContextBytes = currentBytes;
      // Count each retained context in full, even though unchanged parts share references.
      const bytes =
        jsonBytes({ ...receipt, message: null, context: null }) -
        8 +
        jsonBytes(input.message) +
        currentBytes;
      entries.push({ receipt, summary, bytes });
      retainedBytes += bytes;
      while (
        entries.length > agentReceiptPolicy.records ||
        retainedBytes > agentReceiptPolicy.retainedBytes
      ) {
        const oldest = entries.shift();
        if (!oldest) break;
        retainedBytes -= oldest.bytes;
        evicted++;
      }
    },
    index(query: z.output<typeof agentReceiptQuerySchema> = {}) {
      const after =
        query.journal_id === journalId &&
        (query.after_sequence ?? 0) <= sequence
          ? (query.after_sequence ?? 0)
          : 0;
      return {
        journal_id: journalId,
        total_received: sequence,
        first_retained_sequence: entries[0]?.summary.sequence ?? sequence + 1,
        evicted,
        retained_bytes: retainedBytes,
        receipts: entries
          .filter(({ summary }) => summary.sequence > after)
          .map(({ summary }) => summary)
          .toReversed(),
      };
    },
    detail(id: string) {
      const receipt = entries.find((entry) => entry.receipt.id === id)?.receipt;
      return receipt ? { journal_id: journalId, receipt } : null;
    },
    id() {
      return journalId;
    },
  };
}
