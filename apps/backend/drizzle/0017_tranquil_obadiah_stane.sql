CREATE TABLE "perception_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"device_id" text NOT NULL,
	"channel" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "perception_windows_source_time" ON "perception_windows" USING btree ("account_id","home_id","device_id","channel","started_at","id");--> statement-breakpoint
CREATE INDEX "perception_windows_history_time" ON "perception_windows" USING btree ("account_id","home_id","started_at","id");--> statement-breakpoint
CREATE INDEX "perception_windows_expiry" ON "perception_windows" USING btree ("expires_at");