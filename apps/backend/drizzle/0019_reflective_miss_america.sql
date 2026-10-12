CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"device_id" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_records" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "source_metadata" jsonb;--> statement-breakpoint
CREATE INDEX "device_commands_household_time_idx" ON "device_commands" USING btree ("account_id","home_id","called_at","id");--> statement-breakpoint
CREATE INDEX "device_commands_device_time_idx" ON "device_commands" USING btree ("device_id","called_at","id");--> statement-breakpoint
CREATE INDEX "device_commands_expiry_idx" ON "device_commands" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "context_records_topic_expiry_idx" ON "context_records" USING btree ("topic","expires_at");--> statement-breakpoint
ALTER TABLE "context_records" ADD CONSTRAINT "context_records_source_key_unique" UNIQUE("source_key");