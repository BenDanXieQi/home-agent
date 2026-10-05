DROP TABLE "identity_reference_state";
--> statement-breakpoint
-- Rewrite persisted member evidence to the current snapshot contract once.
CREATE FUNCTION pg_temp.identity_snapshot_data(value jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN (
      SELECT coalesce(jsonb_object_agg(
        CASE WHEN key = 'contentVersion' THEN 'revision' ELSE key END,
        pg_temp.identity_snapshot_data(entry)
      ), '{}'::jsonb)
      FROM jsonb_each(value) AS fields(key, entry)
      WHERE key NOT IN ('eligibilityVersion', 'matchingVersion', 'referenceRevision')
    )
    WHEN 'array' THEN (
      SELECT coalesce(jsonb_agg(pg_temp.identity_snapshot_data(entry) ORDER BY position), '[]'::jsonb)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(entry, position)
    )
    ELSE value
  END
$$;
--> statement-breakpoint
UPDATE "context_records"
SET "data" = pg_temp.identity_snapshot_data("data"),
    "evidence" = pg_temp.identity_snapshot_data("evidence")
WHERE "topic" = 'member_sighting';
--> statement-breakpoint
DROP FUNCTION pg_temp.identity_snapshot_data(jsonb);
