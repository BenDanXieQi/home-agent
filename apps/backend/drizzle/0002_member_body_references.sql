ALTER TABLE "identity_samples" ALTER COLUMN "feature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_samples" ADD COLUMN "appearance" jsonb;