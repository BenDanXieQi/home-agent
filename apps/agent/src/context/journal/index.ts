import { freeze } from "@home-agent/api/immutable";
import { collectReceiptChanges } from "./changes";
import { agentContextPartsSchema } from "@home-agent/api/agent-context";
import type { z } from "zod";
import {
  agentReceiptSummarySchema,
  type agentReceiptSchema,
  type agentReceiptQuerySchema,
} from "../contracts";

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function createReceiptJournal() {
  let journalId = crypto.randomUUID();
  let sequence = 0;
  let previousContextBytes = 0;
  const entries: {
    receipt: z.infer<typeof agentReceiptSchema>;
    summary: z.infer<typeof agentReceiptSummarySchema>;
  }[] = [];
  return {
    clear() {
      journalId = crypto.randomUUID();
      sequence = 0;
      previousContextBytes = 0;
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
      const currentBytes = jsonBytes(input.context);
      const changes = collectReceiptChanges(input, previous);
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
      entries.push({ receipt, summary });
    },
    index(query: z.output<typeof agentReceiptQuerySchema> = {}) {
      const afterSequence = query.after_sequence ?? 0;
      const effectiveAfterSequence =
        query.journal_id === journalId && afterSequence <= sequence
          ? afterSequence
          : 0;
      return {
        journal_id: journalId,
        total_received: sequence,
        receipts: entries
          .filter(({ summary }) => summary.sequence > effectiveAfterSequence)
          .map(({ summary }) => summary)
          .toReversed(),
      };
    },
    detail: (id: string) => {
      const receipt = entries.find((entry) => entry.receipt.id === id)?.receipt;
      return receipt ? { journal_id: journalId, receipt } : null;
    },
    id: () => journalId,
  };
}
