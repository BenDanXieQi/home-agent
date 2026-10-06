-- Keep the evidence of existing executions on their run before removing transient input storage.
ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_id_automation_inputs_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "input" jsonb;
--> statement-breakpoint
UPDATE "automation_runs" AS r SET "input" = i."input"
FROM "automation_inputs" AS i WHERE r."id" = i."id";
--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "input" SET NOT NULL;
--> statement-breakpoint
-- Fresh installations initialize the worker schema after business migrations.
DO $$
DECLARE retired_job_key text;
BEGIN
  IF to_regclass('graphile_worker.jobs') IS NOT NULL THEN
    FOR retired_job_key IN
      SELECT key FROM graphile_worker.jobs
      WHERE task_identifier IN ('automation_evaluate', 'automation_timer') AND key IS NOT NULL
    LOOP
      PERFORM graphile_worker.remove_job(retired_job_key);
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "automation_inputs";
--> statement-breakpoint
DROP TABLE "automation_states";
