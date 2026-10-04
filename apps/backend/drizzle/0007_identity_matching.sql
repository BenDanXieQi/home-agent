ALTER TABLE "identity_reference_state" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "identity_reference_state" ADD COLUMN "processing_version" text;--> statement-breakpoint
ALTER TABLE "identity_reference_state" ADD COLUMN "policy" jsonb;