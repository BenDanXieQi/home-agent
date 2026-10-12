ALTER TABLE "context_records" ADD COLUMN "source_occurred_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "context_records_material_source_time_idx" ON "context_records" USING btree ("topic","source_occurred_at","id") WHERE "context_records"."kind" = 'observation';--> statement-breakpoint
CREATE INDEX "context_records_material_scope_time_idx" ON "context_records" USING btree (("data"->>'account_id'),("data"->>'home_id'),"topic","occurred_at","id") WHERE "context_records"."kind" = 'observation';--> statement-breakpoint
UPDATE "context_records"
SET "source_occurred_at" = ("data"->'source'->>'source_time')::timestamptz
WHERE "topic" IN ('miot_event', 'mijia_scene_execution', 'xiaoai_conversation', 'mijia_device_history')
  AND "data"->'source'->>'source_time' IS NOT NULL;
--> statement-breakpoint
UPDATE "automation_actions" SET "timing" = "timing" - 'feedback'
WHERE "timing" ? 'feedback';
