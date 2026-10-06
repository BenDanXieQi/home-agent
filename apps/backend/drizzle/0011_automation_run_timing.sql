ALTER TABLE "automation_actions" ADD COLUMN "timing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_decisions" ADD COLUMN "timing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_inputs" ADD COLUMN "timing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "timing" jsonb DEFAULT '{}'::jsonb NOT NULL;