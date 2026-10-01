CREATE TYPE "public"."context_certainty" AS ENUM('supported', 'tentative', 'unknown', 'conflicting');--> statement-breakpoint
CREATE TYPE "public"."context_entity_role" AS ENUM('subject', 'participant', 'location', 'source');--> statement-breakpoint
CREATE TYPE "public"."context_entity_type" AS ENUM('person', 'pet', 'room', 'device');--> statement-breakpoint
CREATE TYPE "public"."context_kind" AS ENUM('observation', 'assessment');--> statement-breakpoint
CREATE TYPE "public"."household_subject_kind" AS ENUM('person', 'pet');--> statement-breakpoint
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
	CONSTRAINT "context_records_topic_nonempty" CHECK (length(btrim("context_records"."topic")) > 0),
	CONSTRAINT "context_records_summary_nonempty" CHECK (length(btrim("context_records"."summary")) > 0),
	CONSTRAINT "context_records_scope_epoch_nonempty" CHECK (length(btrim("context_records"."scope_epoch")) > 0),
	CONSTRAINT "context_records_data_object" CHECK (jsonb_typeof("context_records"."data") = 'object'),
	CONSTRAINT "context_records_evidence_array" CHECK (jsonb_typeof("context_records"."evidence") = 'array'),
	CONSTRAINT "context_records_expiry_order" CHECK ("context_records"."expires_at" IS NULL OR "context_records"."expires_at" >= "context_records"."occurred_at")
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
ALTER TABLE "context_entities" ADD CONSTRAINT "context_entities_context_id_context_records_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."context_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_entities_entity_idx" ON "context_entities" USING btree ("entity_type","entity_id","context_id");--> statement-breakpoint
CREATE INDEX "context_records_occurred_at_id_idx" ON "context_records" USING btree ("occurred_at","id");