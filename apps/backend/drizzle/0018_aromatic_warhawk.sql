ALTER TABLE "perception_windows" ADD COLUMN "observed_start_at" numeric;--> statement-breakpoint
ALTER TABLE "perception_windows" ADD COLUMN "observed_end_at" numeric;--> statement-breakpoint
UPDATE "perception_windows" AS w
SET "observed_start_at" = least(
  w.started_at::numeric,
  CASE WHEN w.summary->'audio'->'run' <> 'null'::jsonb THEN (w.summary->'audio'->>'startedAt')::numeric END,
  (SELECT min((segment->>'observedStartAt')::numeric)
   FROM jsonb_array_elements(w.summary->'speech'->'segments') segment)
), "observed_end_at" = greatest(
  w.ended_at::numeric,
  CASE WHEN w.summary->'audio'->'run' <> 'null'::jsonb THEN (w.summary->'audio'->>'endedAt')::numeric END,
  (SELECT max((segment->>'observedEndAt')::numeric)
   FROM jsonb_array_elements(w.summary->'speech'->'segments') segment)
);
--> statement-breakpoint
ALTER TABLE "perception_windows" ALTER COLUMN "observed_start_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "perception_windows" ALTER COLUMN "observed_end_at" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "perception_windows_observed_range" ON "perception_windows" USING gist (numrange("observed_start_at", "observed_end_at", '[]'));