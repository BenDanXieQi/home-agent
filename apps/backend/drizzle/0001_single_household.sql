ALTER TABLE "household_events" DROP CONSTRAINT "household_events_source_identity";--> statement-breakpoint
DROP INDEX "automation_reviews_household_idx";--> statement-breakpoint
DROP INDEX "automations_household_idx";--> statement-breakpoint
DROP INDEX "context_records_material_scope_source_time_idx";--> statement-breakpoint
DROP INDEX "context_records_material_scope_time_idx";--> statement-breakpoint
DROP INDEX "automation_model_budget_idx";--> statement-breakpoint
DROP INDEX "household_events_query_idx";--> statement-breakpoint
DROP INDEX "household_events_type_idx";--> statement-breakpoint
DROP INDEX "perception_windows_source_time";--> statement-breakpoint
DROP INDEX "perception_windows_history_time";--> statement-breakpoint
ALTER TABLE "household_directories" DROP CONSTRAINT "household_directories_account_id_home_id_pk";--> statement-breakpoint
ALTER TABLE "household_directories" ADD COLUMN "id" integer PRIMARY KEY DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "context_records_material_time_idx" ON "context_records" USING btree ("topic","occurred_at","id") WHERE "context_records"."kind" = 'observation';--> statement-breakpoint
CREATE INDEX "automation_model_budget_idx" ON "automation_model_admissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "household_events_query_idx" ON "household_events" USING btree ("accepted_at","id");--> statement-breakpoint
CREATE INDEX "household_events_type_idx" ON "household_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "perception_windows_source_time" ON "perception_windows" USING btree ("device_id","channel","started_at","id");--> statement-breakpoint
CREATE INDEX "perception_windows_history_time" ON "perception_windows" USING btree ("started_at","id");--> statement-breakpoint
ALTER TABLE "automation_model_admissions" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "automation_model_admissions" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "automation_reviews" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "automation_reviews" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "household_directories" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "household_directories" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "household_events" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "household_events" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "perception_windows" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "perception_windows" DROP COLUMN "home_id";--> statement-breakpoint
ALTER TABLE "household_events" ADD CONSTRAINT "household_events_source_identity" UNIQUE("producer_id","source_event_id");--> statement-breakpoint
ALTER TABLE "household_directories" ADD CONSTRAINT "household_directories_singleton" CHECK ("household_directories"."id" = 1);
--> statement-breakpoint
WITH normalized AS (
  SELECT "id", "source_key", "created_at",
    CASE
      WHEN "source_key"::json->>2 IN (
        'xiaoai_conversation', 'mijia_scene_execution', 'mijia_device_history'
      ) THEN (
        SELECT '[' || string_agg(element::text, ',' ORDER BY position) || ']'
        FROM json_array_elements("source_key"::json)
          WITH ORDINALITY AS identity_parts(element, position)
        WHERE position > 2
      )
      ELSE "source_key"
    END AS canonical_key
  FROM "context_records"
  WHERE "kind" = 'observation'
    AND "source_key" IS NOT NULL
    AND "topic" IN (
      'xiaoai_conversation', 'mijia_scene_execution', 'mijia_device_history',
      'supplier_material_identity'
    )
), ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY canonical_key
    ORDER BY ("source_key" = canonical_key) DESC, "created_at", "id"
  ) AS identity_rank
  FROM normalized
)
UPDATE "context_records"
SET "source_key" = NULL
FROM ranked
WHERE "context_records"."id" = ranked."id"
  AND ranked.identity_rank > 1;
--> statement-breakpoint
UPDATE "context_records"
SET "source_key" = (
  SELECT '[' || string_agg(element::text, ',' ORDER BY position) || ']'
  FROM json_array_elements("context_records"."source_key"::json)
    WITH ORDINALITY AS identity_parts(element, position)
  WHERE position > 2
)
WHERE "kind" = 'observation'
  AND "source_key" IS NOT NULL
  AND "source_key"::json->>2 IN (
    'xiaoai_conversation', 'mijia_scene_execution', 'mijia_device_history'
  )
  AND "topic" IN (
    'xiaoai_conversation',
    'mijia_scene_execution',
    'mijia_device_history',
    'supplier_material_identity'
  );
