CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
CREATE TYPE "public"."context_certainty" AS ENUM('supported', 'tentative', 'unknown', 'conflicting');--> statement-breakpoint
CREATE TYPE "public"."context_entity_role" AS ENUM('subject', 'participant', 'location', 'source');--> statement-breakpoint
CREATE TYPE "public"."context_entity_type" AS ENUM('person', 'pet', 'room', 'device');--> statement-breakpoint
CREATE TYPE "public"."context_kind" AS ENUM('observation', 'assessment');--> statement-breakpoint
CREATE TYPE "public"."household_subject_kind" AS ENUM('person', 'pet');--> statement-breakpoint
CREATE TABLE "automation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"timing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"timing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_model_admissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_review_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"request" jsonb,
	"result" jsonb,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"automation_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"last_fingerprint" text,
	"active_request_id" uuid,
	"next_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"evaluation" jsonb NOT NULL,
	"timing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_entities" (
	"context_id" uuid NOT NULL,
	"entity_type" "context_entity_type" NOT NULL,
	"entity_id" text NOT NULL,
	"role" "context_entity_role" NOT NULL,
	CONSTRAINT "context_entities_context_id_entity_type_entity_id_role_pk" PRIMARY KEY("context_id","entity_type","entity_id","role"),
	CONSTRAINT "context_entities_entity_id_nonempty" CHECK (length(btrim("context_entities"."entity_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "context_records" (
	"source_key" text,
	"source_occurred_at" timestamp with time zone,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "context_kind" NOT NULL,
	"topic" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"certainty" "context_certainty" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_epoch" text NOT NULL,
	CONSTRAINT "context_records_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "context_records_topic_nonempty" CHECK (length(btrim("context_records"."topic")) > 0),
	CONSTRAINT "context_records_summary_nonempty" CHECK (length(btrim("context_records"."summary")) > 0),
	CONSTRAINT "context_records_scope_epoch_nonempty" CHECK (length(btrim("context_records"."scope_epoch")) > 0),
	CONSTRAINT "context_records_data_object" CHECK (jsonb_typeof("context_records"."data") = 'object'),
	CONSTRAINT "context_records_evidence_array" CHECK (jsonb_typeof("context_records"."evidence") = 'array'),
	CONSTRAINT "context_records_expiry_order" CHECK ("context_records"."expires_at" IS NULL OR "context_records"."expires_at" >= "context_records"."occurred_at")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"key" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_history_state" (
	"device_id" text NOT NULL,
	"item" text NOT NULL,
	"value" jsonb NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "device_history_state_device_id_item_pk" PRIMARY KEY("device_id","item"),
	CONSTRAINT "device_history_state_device_nonempty" CHECK (length("device_history_state"."device_id") > 0),
	CONSTRAINT "device_history_state_value_scalar" CHECK (jsonb_typeof("device_history_state"."value") IN ('number', 'boolean', 'string', 'null')),
	CONSTRAINT "device_history_state_item" CHECK (("device_history_state"."item" = 'online' AND jsonb_typeof("device_history_state"."value") = 'boolean' AND "device_history_state"."metadata" IS NULL)
      OR ("device_history_state"."item" ~ '^[1-9][0-9]*[.][1-9][0-9]*$' AND "device_history_state"."metadata" IS NOT NULL AND jsonb_typeof("device_history_state"."metadata") = 'object'))
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
	"source_metadata" jsonb,
	"source" text NOT NULL,
	CONSTRAINT "device_observations_received_at_observation_id_pk" PRIMARY KEY("received_at","observation_id"),
	CONSTRAINT "device_observations_sequence_nonnegative" CHECK ("device_observations"."input_sequence" >= 0),
	CONSTRAINT "device_observations_value_scalar" CHECK (jsonb_typeof("device_observations"."value") IN ('number', 'boolean', 'string', 'null')),
	CONSTRAINT "device_observations_device_nonempty" CHECK (length("device_observations"."device_id") > 0),
	CONSTRAINT "device_observations_record" CHECK (("device_observations"."kind" = 'property' AND "device_observations"."definition_id" IS NOT NULL AND "device_observations"."source" IN ('push', 'retained', 'read'))
        OR ("device_observations"."kind" = 'online' AND "device_observations"."definition_id" IS NULL AND jsonb_typeof("device_observations"."value") = 'boolean' AND "device_observations"."source" IN ('push', 'retained', 'directory')))
);
--> statement-breakpoint
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
CREATE TABLE "household_directories" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"directory" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_directories_singleton" CHECK ("household_directories"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "household_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"producer_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"device_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submission" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "household_events_source_identity" UNIQUE("producer_id","source_event_id"),
	CONSTRAINT "household_events_valid_interval" CHECK ("household_events"."expires_at" > "household_events"."occurred_at")
);
--> statement-breakpoint
CREATE TABLE "household_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "household_subject_kind" NOT NULL,
	"name" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_subjects_name_nonempty" CHECK (length(btrim("household_subjects"."name")) > 0),
	CONSTRAINT "household_subjects_details_object" CHECK (jsonb_typeof("household_subjects"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "identity_members" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"image_key" uuid NOT NULL,
	"image_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"source" jsonb NOT NULL,
	"quality" jsonb NOT NULL,
	"model_version" text NOT NULL,
	"processing_version" text NOT NULL,
	"feature" jsonb,
	"appearance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_samples_image_key_unique" UNIQUE("image_key"),
	CONSTRAINT "identity_samples_member_sha256_unique" UNIQUE("member_id","sha256"),
	CONSTRAINT "identity_samples_bytes_positive" CHECK ("identity_samples"."image_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "mijia_home_selections" (
	"account_key" text PRIMARY KEY NOT NULL,
	"home_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"channel" integer,
	"space_id" uuid,
	"passage_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_bindings_one_target" CHECK (("observation_bindings"."space_id" is null) <> ("observation_bindings"."passage_id" is null)),
	CONSTRAINT "observation_bindings_device_nonempty" CHECK (length(btrim("observation_bindings"."device_id")) > 0),
	CONSTRAINT "observation_bindings_channel" CHECK ("observation_bindings"."channel" is null or "observation_bindings"."channel" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "passages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"space_a_id" uuid NOT NULL,
	"space_b_id" uuid NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passages_name_nonempty" CHECK (length(btrim("passages"."name")) > 0),
	CONSTRAINT "passages_endpoints_differ" CHECK ("passages"."space_a_id" <> "passages"."space_b_id")
);
--> statement-breakpoint
CREATE TABLE "perception_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"channel" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"observed_start_at" numeric NOT NULL,
	"observed_end_at" numeric NOT NULL,
	"expires_at" bigint NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_name_nonempty" CHECK (length(btrim("spaces"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_decisions" ADD CONSTRAINT "automation_decisions_id_automation_runs_id_fk" FOREIGN KEY ("id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_review_runs" ADD CONSTRAINT "automation_review_runs_review_id_automation_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."automation_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_reviews" ADD CONSTRAINT "automation_reviews_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_entities" ADD CONSTRAINT "context_entities_context_id_context_records_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."context_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_observations" ADD CONSTRAINT "device_observations_definition_id_device_property_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."device_property_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_members" ADD CONSTRAINT "identity_members_member_id_household_subjects_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_samples" ADD CONSTRAINT "identity_samples_member_id_identity_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."identity_members"("member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_bindings" ADD CONSTRAINT "observation_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_bindings" ADD CONSTRAINT "observation_bindings_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "public"."passages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_space_a_id_spaces_id_fk" FOREIGN KEY ("space_a_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_space_b_id_spaces_id_fk" FOREIGN KEY ("space_b_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_actions_run_idx" ON "automation_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_model_budget_idx" ON "automation_model_admissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "automation_review_runs_history_idx" ON "automation_review_runs" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_reviews_node_idx" ON "automation_reviews" USING btree ("automation_id","node_id");--> statement-breakpoint
CREATE INDEX "automation_runs_history_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "context_entities_entity_idx" ON "context_entities" USING btree ("entity_type","entity_id","context_id");--> statement-breakpoint
CREATE INDEX "context_records_material_source_time_idx" ON "context_records" USING btree ("topic","source_occurred_at","id") WHERE "context_records"."kind" = 'observation';--> statement-breakpoint
CREATE INDEX "context_records_material_time_idx" ON "context_records" USING btree ("topic","occurred_at","id") WHERE "context_records"."kind" = 'observation';--> statement-breakpoint
CREATE INDEX "context_records_topic_expiry_idx" ON "context_records" USING btree ("topic","expires_at");--> statement-breakpoint
CREATE INDEX "context_records_occurred_at_id_idx" ON "context_records" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "context_records_sighting_first_id_idx" ON "context_records" USING btree ((("data"->>'firstObservedAt')::numeric),"id") WHERE "context_records"."topic" = 'member_sighting';--> statement-breakpoint
CREATE INDEX "context_records_sighting_last_id_idx" ON "context_records" USING btree ((("data"->>'lastObservedAt')::numeric),"id") WHERE "context_records"."topic" = 'member_sighting';--> statement-breakpoint
CREATE INDEX "context_records_sighting_member_first_id_idx" ON "context_records" USING btree (("data" #>> '{attribution,current,association,memberId}'),(("data"->>'firstObservedAt')::numeric),"id") WHERE "context_records"."topic" = 'member_sighting';--> statement-breakpoint
CREATE INDEX "context_records_sighting_source_first_id_idx" ON "context_records" USING btree (("data"->>'deviceId'),("data"->>'channel'),(("data"->>'firstObservedAt')::numeric),"id") WHERE "context_records"."topic" = 'member_sighting';--> statement-breakpoint
CREATE INDEX "device_commands_time_idx" ON "device_commands" USING btree ("called_at","id");--> statement-breakpoint
CREATE INDEX "device_commands_device_time_idx" ON "device_commands" USING btree ("device_id","called_at","id");--> statement-breakpoint
CREATE INDEX "device_commands_expiry_idx" ON "device_commands" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_observations_device_kind_time_idx" ON "device_observations" USING btree ("device_id","kind","received_at","scope_epoch","input_sequence","observation_id");--> statement-breakpoint
CREATE INDEX "device_observations_definition_time_idx" ON "device_observations" USING btree ("definition_id","received_at","scope_epoch","input_sequence","observation_id");--> statement-breakpoint
CREATE INDEX "device_property_definitions_property_idx" ON "device_property_definitions" USING btree ("device_id","siid","piid");--> statement-breakpoint
CREATE INDEX "household_events_query_idx" ON "household_events" USING btree ("accepted_at","id");--> statement-breakpoint
CREATE INDEX "household_events_type_idx" ON "household_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "identity_samples_member_idx" ON "identity_samples" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "observation_bindings_space_idx" ON "observation_bindings" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "observation_bindings_passage_idx" ON "observation_bindings" USING btree ("passage_id");--> statement-breakpoint
CREATE INDEX "passages_space_a_idx" ON "passages" USING btree ("space_a_id");--> statement-breakpoint
CREATE INDEX "passages_space_b_idx" ON "passages" USING btree ("space_b_id");--> statement-breakpoint
CREATE INDEX "perception_windows_source_time" ON "perception_windows" USING btree ("device_id","channel","started_at","id");--> statement-breakpoint
CREATE INDEX "perception_windows_history_time" ON "perception_windows" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "perception_windows_observed_range" ON "perception_windows" USING gist (numrange("observed_start_at", "observed_end_at", '[]'));--> statement-breakpoint
CREATE INDEX "perception_windows_expiry" ON "perception_windows" USING btree ("expires_at");
--> statement-breakpoint
SELECT create_hypertable('device_observations', by_range('received_at'));
--> statement-breakpoint
ALTER TABLE device_observations SET (
  timescaledb.enable_columnstore = true,
  timescaledb.orderby = 'received_at DESC'
);
--> statement-breakpoint
DO $columnstore$
DECLARE chunk_interval interval;
BEGIN
  SELECT time_interval INTO STRICT chunk_interval
  FROM timescaledb_information.dimensions
  WHERE hypertable_schema = 'public' AND hypertable_name = 'device_observations'
    AND column_name = 'received_at';
  CALL add_columnstore_policy('device_observations', after => chunk_interval);
END
$columnstore$;
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
