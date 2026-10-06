CREATE TABLE "device_property_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"siid" integer NOT NULL,
	"piid" integer NOT NULL,
	"metadata" jsonb NOT NULL,
	CONSTRAINT "device_property_definitions_device_nonempty" CHECK (length("device_property_definitions"."device_id") > 0),
	CONSTRAINT "device_property_definitions_siid_positive" CHECK ("device_property_definitions"."siid" > 0),
	CONSTRAINT "device_property_definitions_piid_positive" CHECK ("device_property_definitions"."piid" > 0),
	CONSTRAINT "device_property_definitions_metadata_object" CHECK (jsonb_typeof("device_property_definitions"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "device_observations" (
	"received_at" timestamp with time zone NOT NULL,
	"observation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"device_id" text NOT NULL,
	"definition_id" uuid,
	"scope_epoch" uuid NOT NULL,
	"input_sequence" bigint NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "device_observations_received_at_observation_id_pk" PRIMARY KEY("received_at","observation_id"),
	CONSTRAINT "device_observations_sequence_nonnegative" CHECK ("device_observations"."input_sequence" >= 0),
	CONSTRAINT "device_observations_value_scalar" CHECK (jsonb_typeof("device_observations"."value") IN ('number', 'boolean', 'string', 'null')),
	CONSTRAINT "device_observations_device_nonempty" CHECK (length("device_observations"."device_id") > 0),
	CONSTRAINT "device_observations_record" CHECK (("device_observations"."kind" = 'property' AND "device_observations"."definition_id" IS NOT NULL AND "device_observations"."source" IN ('push', 'retained', 'read'))
        OR ("device_observations"."kind" = 'online' AND "device_observations"."definition_id" IS NULL AND jsonb_typeof("device_observations"."value") = 'boolean' AND "device_observations"."source" IN ('push', 'retained', 'directory')))
);
--> statement-breakpoint
ALTER TABLE "device_observations" ADD CONSTRAINT "device_observations_definition_id_device_property_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."device_property_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_property_definitions_property_idx" ON "device_property_definitions" USING btree ("device_id","siid","piid");--> statement-breakpoint
CREATE INDEX "device_observations_device_kind_time_idx" ON "device_observations" USING btree ("device_id","kind","received_at","scope_epoch","input_sequence","observation_id");--> statement-breakpoint
CREATE INDEX "device_observations_definition_time_idx" ON "device_observations" USING btree ("definition_id","received_at","scope_epoch","input_sequence","observation_id");
--> statement-breakpoint
SELECT create_hypertable('device_observations', by_range('received_at'));
--> statement-breakpoint
ALTER TABLE device_observations SET (
  timescaledb.enable_columnstore = true,
  timescaledb.orderby = 'received_at DESC'
);
--> statement-breakpoint
DO $migration$
DECLARE chunk_interval interval;
BEGIN
  SELECT time_interval INTO STRICT chunk_interval
  FROM timescaledb_information.dimensions
  WHERE hypertable_schema = 'public' AND hypertable_name = 'device_observations'
    AND column_name = 'received_at';
  CALL add_columnstore_policy('device_observations', after => chunk_interval);
END
$migration$;
--> statement-breakpoint
SELECT add_retention_policy('device_observations', INTERVAL '365 days');
--> statement-breakpoint
CREATE PROCEDURE cleanup_device_property_definitions(job_id integer, config jsonb)
LANGUAGE plpgsql AS $maintenance$
DECLARE candidates uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('household_binding', 0));
  SELECT array_agg(id) INTO candidates FROM (
    SELECT d.id FROM device_property_definitions d
    WHERE NOT EXISTS (SELECT 1 FROM device_observations o WHERE o.definition_id = d.id)
    ORDER BY d.id LIMIT 1000
  ) unreferenced;
  -- Keep the locking statement independent of the compressed report scan.
  SELECT array_agg(id) INTO candidates FROM (
    SELECT d.id FROM device_property_definitions d
    WHERE d.id = ANY(candidates)
    ORDER BY d.id FOR UPDATE OF d SKIP LOCKED
  ) locked;
  DELETE FROM device_property_definitions d
  WHERE d.id = ANY(candidates)
    AND NOT EXISTS (SELECT 1 FROM device_observations o WHERE o.definition_id = d.id);
END
$maintenance$;
--> statement-breakpoint
SELECT add_job('cleanup_device_property_definitions', schedule_interval)
FROM timescaledb_information.jobs
WHERE hypertable_schema = 'public' AND hypertable_name = 'device_observations'
  AND proc_name = 'policy_retention';
