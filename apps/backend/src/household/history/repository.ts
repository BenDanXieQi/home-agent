import { addAbortListener } from "node:events";
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
const sessionSchema = z.object({
  pid: z.int32().positive(),
  backend_start: deviceHistoryTimeSchema,
  transaction_start: deviceHistoryTimeSchema,
});

export function createDeviceHistoryRepository(db: Database) {
  const access = createHouseholdBindingAccess(db);
  const dialect = new PgDialect();
  return {
    async save(
      context: HistoryAccess,
      report: z.infer<typeof deviceHistoryReportSchema>,
    ) {
      return access(context.identity, context.assertCurrent, async (tx) => {
        const valid = await tx.execute(
          sql`select ${report.received_at}::timestamptz >= now() - make_interval(days => ${deviceHistoryPolicy.retentionDays}) as valid`,
        );
        if (!valid[0]?.valid) return false;
        await lockTransaction(
          tx,
          JSON.stringify([
            "device_property_definition",
            report.device_id,
            report.siid,
            report.piid,
          ]),
          "exclusive",
        );
        const metadata = JSON.stringify(report.metadata);
        const rows =
          await tx.execute(sql`select id from device_property_definitions
          where device_id = ${report.device_id} and siid = ${report.siid} and piid = ${report.piid}
          and metadata = ${metadata}::jsonb limit 1 for key share`);
        const id = rows[0]?.id ?? crypto.randomUUID();
        if (!rows.length)
          await tx.execute(sql`insert into device_property_definitions (id, device_id, siid, piid, metadata)
          values (${id}, ${report.device_id}, ${report.siid}, ${report.piid}, ${metadata}::jsonb)`);
        context.assertCurrent();
        await tx.execute(sql`insert into device_property_observations
          (received_at, observation_id, definition_id, scope_epoch, input_sequence, value, source)
          values (${report.received_at}::timestamptz, ${report.observation_id}, ${id}, ${report.scope_epoch}, ${String(report.input_sequence)}::bigint, ${JSON.stringify(report.value)}::jsonb, ${report.source})`);
        return true;
      });
    },
    async read(
      context: HistoryAccess & { signal: AbortSignal },
      input: z.infer<typeof deviceHistoryQuerySchema>,
      after:
        | { binding: string; position: z.infer<typeof historyPositionSchema> }
        | undefined,
      receive: (
        candidate: z.infer<typeof rowSchema>,
        bindingTime: string,
      ) => boolean,
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
          const session = sessionSchema.parse(
            (
              await prepare(sql`${transactionTimeouts(householdLimits.transactionMs)},
                pg_backend_pid() as pid,
                to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as backend_start,
                to_char(xact_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as transaction_start
                from pg_stat_activity where pid = pg_backend_pid()`)
            )[0],
          );
          const cancel = () =>
            db.$client`
              select pg_cancel_backend(pid) from pg_stat_activity
              where pid = ${session.pid}
                and backend_start = ${session.backend_start}::timestamptz
                and xact_start = ${session.transaction_start}::timestamptz
            `.catch((error: unknown) => {
              console.warn(
                "Device history cancellation failed",
                error instanceof Error ? error.name : "unknown",
              );
            });
          const execute = async (
            statement: SQL,
            consume?: (candidate: z.infer<typeof rowSchema>) => boolean,
          ) => {
            context.signal.throwIfAborted();
            context.assertCurrent();
            const pending = prepare(statement);
            let cancellation: ReturnType<typeof cancel> | undefined;
            const listener = addAbortListener(context.signal, () => {
              cancellation = cancel();
            });
            let callbackError: unknown;
            try {
              const result = consume
                ? await pending.cursor(1, (rows) => {
                    try {
                      context.signal.throwIfAborted();
                      context.assertCurrent();
                      if (!consume(rowSchema.parse(rows[0])))
                        return db.$client.CLOSE;
                      return undefined;
                    } catch (error) {
                      callbackError = error;
                      return db.$client.CLOSE;
                    }
                  })
                : await pending;
              if (callbackError) throw callbackError;
              context.signal.throwIfAborted();
              context.assertCurrent();
              return result;
            } finally {
              listener[Symbol.dispose]();
              // Keep this transaction reserved until cancellation has settled.
              await cancellation;
            }
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
          const properties = input.properties
            ? JSON.stringify(input.properties)
            : null;
          await execute(
            input.representation === "observations"
              ? sql`
WITH page AS (
            select o.* from device_property_observations o join device_property_definitions d on d.id = o.definition_id
            where (${properties}::jsonb is null or exists (
              select 1 from jsonb_to_recordset(${properties}::jsonb) as p(device_id text, siid integer, piid integer)
              where (p.device_id,p.siid,p.piid) = (d.device_id,d.siid,d.piid)))
            and o.received_at >= greatest(${input.start}::timestamptz, now() - make_interval(days => ${deviceHistoryPolicy.retentionDays}))
            and o.received_at < ${input.end}::timestamptz
            and (${position?.at ?? null}::timestamptz is null or
              (o.received_at,o.scope_epoch,o.input_sequence,o.observation_id) >
              (${position?.at ?? null}::timestamptz,${position?.epoch ?? null}::uuid,${position?.sequence ?? null}::bigint,${position?.id ?? null}::uuid))
            order by o.received_at,o.scope_epoch,o.input_sequence,o.observation_id limit ${input.limit + 1}

)
            select jsonb_build_object('device_id', d.device_id, 'siid', d.siid, 'piid', d.piid,
              'definition_id', d.id, 'observation_id', o.observation_id,
              'received_at', to_char(o.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'value', o.value, 'source', o.source, 'metadata', d.metadata) as record,
              jsonb_build_object('at', to_char(o.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                'epoch', o.scope_epoch, 'sequence', o.input_sequence::text, 'id', o.observation_id) as position
FROM page o JOIN device_property_definitions d ON d.id = o.definition_id
ORDER BY o.received_at,o.scope_epoch,o.input_sequence,o.observation_id
          `
              : sql`
WITH selected AS (
    SELECT o.*, d.device_id, d.siid, d.piid
    FROM device_property_observations o
    JOIN device_property_definitions d ON d.id = o.definition_id
    WHERE (${properties}::jsonb IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${properties}::jsonb)
          AS p(device_id text, siid integer, piid integer)
        WHERE (p.device_id, p.siid, p.piid) = (d.device_id, d.siid, d.piid)
      ))
      AND o.received_at >= GREATEST(${input.start}::timestamptz, now() - make_interval(days => ${deviceHistoryPolicy.retentionDays}))
      AND o.received_at < ${input.end}::timestamptz
), compared AS (
    SELECT *,
      (value, definition_id, source) IS DISTINCT FROM
        lag(row(value, definition_id, source)) OVER property_order AS starts_run,
      (value, definition_id, source) IS DISTINCT FROM
        lead(row(value, definition_id, source)) OVER property_order AS ends_run
    FROM selected
    WINDOW property_order AS (
      PARTITION BY device_id, siid, piid
      ORDER BY received_at, scope_epoch, input_sequence, observation_id
    )
), numbered AS (
    SELECT device_id, siid, piid, definition_id, received_at, scope_epoch, input_sequence, observation_id,
      starts_run, ends_run,
      sum(starts_run::integer)
      OVER (PARTITION BY device_id, siid, piid
            ORDER BY received_at, scope_epoch, input_sequence, observation_id
            ROWS UNBOUNDED PRECEDING) AS segment
    FROM compared
), segments AS (
    SELECT device_id, siid, piid, segment, definition_id,
      min(received_at) AS first_received_at,
      max(received_at) AS last_received_at,
      -- Each filter selects the segment's unique boundary row, even when timestamps tie.
      any_value(observation_id) FILTER (WHERE starts_run) AS first_observation_id,
      any_value(observation_id) FILTER (WHERE ends_run) AS last_observation_id,
      any_value(scope_epoch) FILTER (WHERE starts_run) AS first_scope_epoch,
      any_value(input_sequence) FILTER (WHERE starts_run) AS first_input_sequence,
      count(*) AS report_count
    FROM numbered
    GROUP BY device_id, siid, piid, segment, definition_id
), page AS (
 SELECT * FROM segments
WHERE ${position?.at ?? null}::timestamptz IS NULL OR
    (first_received_at, first_scope_epoch, first_input_sequence, first_observation_id)
      > (${position?.at ?? null}::timestamptz, ${position?.epoch ?? null}::uuid, ${position?.sequence ?? null}::bigint, ${position?.id ?? null}::uuid)
ORDER BY first_received_at, first_scope_epoch, first_input_sequence, first_observation_id
LIMIT ${input.limit + 1}
)
SELECT jsonb_build_object(
 'device_id', d.device_id, 'siid', d.siid, 'piid', d.piid,
 'definition_id', d.id, 'value', o.value, 'source', o.source, 'metadata', d.metadata,
 'first_received_at', to_char(first_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'last_received_at', to_char(last_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'first_observation_id', first_observation_id, 'last_observation_id', last_observation_id,
 'report_count', report_count) AS record,
 jsonb_build_object('at', to_char(first_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'epoch', first_scope_epoch, 'sequence', first_input_sequence::text, 'id', first_observation_id) AS position
 FROM page s
 JOIN device_property_observations o ON o.received_at = s.first_received_at AND o.observation_id = s.first_observation_id
 JOIN device_property_definitions d ON d.id = s.definition_id
ORDER BY first_received_at, first_scope_epoch, first_input_sequence, first_observation_id
          `,
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
