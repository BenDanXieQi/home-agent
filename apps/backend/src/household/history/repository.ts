import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  deviceHistoryQuerySchema,
  deviceHistoryReportSchema,
  deviceHistoryPolicy,
  deviceHistoryTimeSchema,
} from "@home-agent/api/device-history";
import { AppError } from "@home-agent/api/errors";
import type { Database } from "../../db";
import {
  lockTransaction,
  transactionTimeouts,
  transactionLock,
} from "../../db/transaction-outcome";
import {
  assertHouseholdBinding,
  createHouseholdBindingAccess,
  householdBindingLock,
} from "../binding-repository";
import { householdLimits } from "../config";
import { HouseholdError } from "../errors";
import type { accessHousehold } from "../access";

type HistoryAccess = Pick<
  ReturnType<typeof accessHousehold>,
  "identity" | "assertCurrent"
>;

export const historyPositionSchema = z.strictObject({
  at: deviceHistoryTimeSchema,
  epoch: z.uuid(),
  sequence: z
    .string()
    .regex(/^(0|[1-9]\d{0,18})$/, { abort: true })
    .refine((value) => BigInt(value) <= 9223372036854775807n, {
      message: "Sequence exceeds PostgreSQL bigint range",
    }),
  id: z.uuid(),
});
const rowSchema = z.object({
  record: z.unknown(),
  position: historyPositionSchema,
});
const bindingSchema = z.object({
  accountKey: deviceHistoryQuerySchema.shape.account_id,
  homeId: deviceHistoryQuerySchema.shape.home_id.nullable(),
  updated_at: deviceHistoryTimeSchema,
});
const parametersSchema = z.array(z.union([z.string(), z.number(), z.null()]));

export function createDeviceHistoryRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const dialect = new PgDialect();
  return {
    async save(
      context: HistoryAccess & { currentDeviceIds: () => ReadonlySet<string> },
      reports: readonly z.infer<typeof deviceHistoryReportSchema>[],
    ) {
      return access(context.identity, context.assertCurrent, async (tx) => {
        const deviceIds = context.currentDeviceIds();
        const candidates = reports.filter((report) =>
          deviceIds.has(report.device_id),
        );
        if (!candidates.length) return { saved: [], suppressed: 0 };
        const deviceId = candidates[0]!.device_id;
        if (candidates.some((report) => report.device_id !== deviceId))
          throw new HouseholdError("invalid_state");
        // One device's ordered batch cannot block writes for another device.
        await lockTransaction(
          tx,
          JSON.stringify(["device_history_changes", deviceId]),
          "exclusive",
        );
        const valid = await tx.execute(
          sql`select observation_id from jsonb_to_recordset(${JSON.stringify(
            candidates.map(({ received_at, observation_id }) => ({
              received_at,
              observation_id,
            })),
          )}::jsonb) as reports (received_at timestamptz, observation_id uuid)
            where received_at >= now() - make_interval(days => ${deviceHistoryPolicy.retentionDays})`,
        );
        const validIds = new Set(
          valid.map((row) => z.uuid().parse(row.observation_id)),
        );
        const observations: {
          report: (typeof reports)[number];
          values: SQL;
        }[] = [];
        for (const report of candidates) {
          if (!validIds.has(report.observation_id)) continue;
          let definitionId: string | null = null;
          if (report.kind === "property") {
            const metadata = JSON.stringify(report.metadata);
            const rows =
              await tx.execute(sql`select id from device_property_definitions
              where device_id = ${report.device_id} and siid = ${report.siid} and piid = ${report.piid}
              and metadata = ${metadata}::jsonb limit 1 for key share`);
            definitionId = z.uuid().parse(rows[0]?.id ?? crypto.randomUUID());
            if (!rows.length)
              await tx.execute(sql`insert into device_property_definitions (id, device_id, siid, piid, metadata)
                values (${definitionId}, ${report.device_id}, ${report.siid}, ${report.piid}, ${metadata}::jsonb)`);
          }
          observations.push({
            report,
            values: sql`(${report.received_at}::timestamptz, ${report.observation_id}::uuid, ${report.kind}::text, ${report.device_id}::text, ${definitionId}::uuid, ${report.scope_epoch}::uuid, ${String(report.input_sequence)}::bigint, ${JSON.stringify(report.value)}::jsonb, ${report.source}::text)`,
          });
        }
        const currentDeviceIds = context.currentDeviceIds();
        const accepted = observations.filter((observation) =>
          currentDeviceIds.has(observation.report.device_id),
        );
        if (!accepted.length) return { saved: [], suppressed: 0 };
        const inserted = await tx.execute(sql`
          WITH incoming (received_at, observation_id, kind, device_id, definition_id,
            scope_epoch, input_sequence, value, source) AS (
            VALUES ${sql.join(
              accepted.map((observation) => observation.values),
              sql`, `,
            )}
          ), addressed AS (
            SELECT i.*, d.metadata,
              CASE WHEN i.kind = 'online' THEN 'online'
                ELSE d.siid::text || '.' || d.piid::text END AS item
            FROM incoming i
            LEFT JOIN device_property_definitions d ON d.id = i.definition_id
          ), compared AS (
            SELECT i.*,
              row_number() OVER item_order AS item_number,
              lag(value) OVER item_order AS previous_value,
              lag(metadata) OVER item_order AS previous_metadata
            FROM addressed i
            WINDOW item_order AS (
              PARTITION BY device_id, item
              ORDER BY input_sequence, received_at, observation_id
            )
          ), changes AS (
            SELECT i.* FROM compared i
            LEFT JOIN device_history_state previous
              ON previous.device_id = i.device_id AND previous.item = i.item
            WHERE CASE WHEN i.item_number = 1
              THEN previous.device_id IS NULL OR
                (i.value, i.metadata) IS DISTINCT FROM (previous.value, previous.metadata)
              ELSE (i.value, i.metadata) IS DISTINCT FROM (i.previous_value, i.previous_metadata)
            END
          ), state_updates AS (
            INSERT INTO device_history_state (device_id, item, value, metadata)
            SELECT DISTINCT ON (device_id, item) device_id, item, value, metadata
            FROM addressed
            ORDER BY device_id, item, input_sequence DESC, received_at DESC, observation_id DESC
            ON CONFLICT (device_id, item) DO UPDATE SET
              value = excluded.value, metadata = excluded.metadata
            WHERE (device_history_state.value, device_history_state.metadata)
              IS DISTINCT FROM (excluded.value, excluded.metadata)
          )
          insert into device_observations
          (received_at, observation_id, kind, device_id, definition_id, scope_epoch, input_sequence, value, source)
          SELECT received_at, observation_id, kind, device_id, definition_id,
            scope_epoch, input_sequence, value, source FROM changes
          RETURNING observation_id`);
        const insertedIds = new Set(
          inserted.map((row) => z.uuid().parse(row.observation_id)),
        );
        const suppressed = accepted.length - insertedIds.size;
        const saved = accepted
          .map((observation) => observation.report)
          .filter((report) => insertedIds.has(report.observation_id));
        // Roll back both the comparison state and history if this device was revoked during I/O.
        if (!context.currentDeviceIds().has(deviceId))
          throw new HouseholdError("stale_session");
        return { saved, suppressed };
      });
    },
    async read(
      context: HistoryAccess & { signal: AbortSignal; timeoutMs: number },
      input: z.infer<typeof deviceHistoryQuerySchema>,
      after:
        | { binding: string; position: z.infer<typeof historyPositionSchema> }
        | undefined,
      receive: (
        candidate: z.infer<typeof rowSchema>,
        bindingTime: string,
      ) => boolean | Promise<boolean>,
      delivery: "page" | "export" = "page",
    ) {
      try {
        context.signal.throwIfAborted();
        await db.$client.begin("read only", async (tx) => {
          context.signal.throwIfAborted();
          context.assertCurrent();
          const prepare = (statement: SQL) => {
            const compiled = dialect.sqlToQuery(statement);
            return tx.unsafe(
              compiled.sql,
              parametersSchema.parse(compiled.params),
            );
          };
          await prepare(
            sql`${transactionTimeouts(delivery === "export" ? context.timeoutMs : householdLimits.transactionMs)}`,
          );
          const execute = async (
            statement: SQL,
            consume?: (
              candidate: z.infer<typeof rowSchema>,
            ) => boolean | Promise<boolean>,
          ) => {
            context.signal.throwIfAborted();
            context.assertCurrent();
            const pending = prepare(statement);
            if (!consume) {
              const result = await pending;
              context.signal.throwIfAborted();
              context.assertCurrent();
              return result;
            }
            let accepting = true;
            for await (const rows of pending.cursor(16)) {
              for (const row of rows) {
                context.signal.throwIfAborted();
                context.assertCurrent();
                if (!(await consume(rowSchema.parse(row)))) {
                  accepting = false;
                  break;
                }
              }
              if (!accepting) break;
            }
            context.signal.throwIfAborted();
            context.assertCurrent();
            return undefined;
          };
          await execute(transactionLock(householdBindingLock, "shared"));
          const bindings = z.array(bindingSchema).parse(
            await execute(sql`
            select account_key as "accountKey", home_id as "homeId",
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
            from mijia_home_selections limit 2`),
          );
          assertHouseholdBinding(context.identity, bindings);
          const bindingTime = bindings[0]!.updated_at;
          if (after && after.binding !== bindingTime)
            throw new AppError("invalid_request");
          const position = after?.position;
          const direction = input.order === "desc" ? sql`DESC` : sql`ASC`;
          const comparison = input.order === "desc" ? sql`<` : sql`>`;
          const limit =
            delivery === "export" ? sql`` : sql`LIMIT ${input.limit + 1}`;
          const observationOrder = sql`o.received_at ${direction}, o.scope_epoch ${direction}, o.input_sequence ${direction}, o.observation_id ${direction}`;
          const properties = input.properties
            ? JSON.stringify(input.properties)
            : null;
          const selected = sql`
    SELECT o.*, d.siid, d.piid
    FROM device_observations o
    LEFT JOIN device_property_definitions d ON d.id = o.definition_id
    WHERE o.kind IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.kinds)}::jsonb))
      AND (${input.device_ids ? JSON.stringify(input.device_ids) : null}::jsonb IS NULL
        OR o.device_id IN (SELECT jsonb_array_elements_text(${input.device_ids ? JSON.stringify(input.device_ids) : null}::jsonb)))
      AND (${properties}::jsonb IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${properties}::jsonb)
          AS p(device_id text, siid integer, piid integer)
        WHERE (p.device_id, p.siid, p.piid) = (o.device_id, d.siid, d.piid)
      ))
      AND o.received_at >= GREATEST(${input.start}::timestamptz, now() - make_interval(days => ${deviceHistoryPolicy.retentionDays}))
      AND o.received_at < ${input.end}::timestamptz`;
          const record = sql`jsonb_build_object('kind', o.kind, 'device_id', o.device_id,
            'value', o.value, 'source', o.source)
            || CASE WHEN o.kind = 'property' THEN jsonb_build_object(
              'siid', d.siid, 'piid', d.piid, 'definition_id', d.id, 'metadata', d.metadata)
              ELSE '{}'::jsonb END`;
          await execute(
            sql`
WITH selected AS (${selected}), page AS (
    SELECT * FROM selected o
    WHERE ${position?.at ?? null}::timestamptz IS NULL OR
      (o.received_at,o.scope_epoch,o.input_sequence,o.observation_id) ${comparison}
      (${position?.at ?? null}::timestamptz,${position?.epoch ?? null}::uuid,${position?.sequence ?? null}::bigint,${position?.id ?? null}::uuid)
    ORDER BY ${observationOrder}
    ${limit}
)
SELECT ${record} || jsonb_build_object(
    'observation_id', o.observation_id,
    'received_at', to_char(o.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS record,
    jsonb_build_object('at', to_char(o.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'epoch', o.scope_epoch, 'sequence', o.input_sequence::text, 'id', o.observation_id) AS position
FROM page o LEFT JOIN device_property_definitions d ON d.id = o.definition_id
ORDER BY ${observationOrder}`,
            (candidate) => receive(candidate, bindingTime),
          );
        });
        context.signal.throwIfAborted();
        context.assertCurrent();
      } catch (error) {
        if (context.signal.aborted) {
          context.assertCurrent();
          context.signal.throwIfAborted();
        }
        if (error instanceof HouseholdError || error instanceof AppError)
          throw error;
        console.warn(
          "Device history query failed",
          error instanceof Error ? error.name : "unknown",
        );
        throw new HouseholdError("home_storage");
      }
    },
  };
}
