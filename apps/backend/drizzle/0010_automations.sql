CREATE TABLE "automation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"input_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_input_identity" UNIQUE("automation_id","revision","input_key")
);
--> statement-breakpoint
CREATE TABLE "automation_model_admissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
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
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"matched" boolean,
	"last_fingerprint" text,
	"active_request_id" uuid,
	"pending" boolean DEFAULT false NOT NULL,
	"next_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"evaluation" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_states" (
	"automation_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"producer_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"device_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submission" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "household_events_source_identity" UNIQUE("account_id","home_id","producer_id","source_event_id"),
	CONSTRAINT "household_events_valid_interval" CHECK ("household_events"."expires_at" > "household_events"."occurred_at")
);
--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_decisions" ADD CONSTRAINT "automation_decisions_id_automation_runs_id_fk" FOREIGN KEY ("id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_inputs" ADD CONSTRAINT "automation_inputs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_review_runs" ADD CONSTRAINT "automation_review_runs_review_id_automation_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."automation_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_id_automation_inputs_id_fk" FOREIGN KEY ("id") REFERENCES "public"."automation_inputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_states" ADD CONSTRAINT "automation_states_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_actions_run_idx" ON "automation_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_model_budget_idx" ON "automation_model_admissions" USING btree ("account_id","home_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_review_runs_history_idx" ON "automation_review_runs" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_reviews_household_idx" ON "automation_reviews" USING btree ("account_id","home_id");--> statement-breakpoint
CREATE INDEX "automation_runs_history_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_household_idx" ON "automations" USING btree ("account_id","home_id");--> statement-breakpoint
CREATE INDEX "household_events_query_idx" ON "household_events" USING btree ("account_id","home_id","accepted_at","id");--> statement-breakpoint
CREATE INDEX "household_events_type_idx" ON "household_events" USING btree ("account_id","home_id","event_type","occurred_at");