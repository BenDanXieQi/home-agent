ALTER TABLE "identity_samples" ADD COLUMN "model_version" text;
--> statement-breakpoint
ALTER TABLE "identity_samples" ADD COLUMN "processing_version" text;
--> statement-breakpoint
ALTER TABLE "identity_samples" ADD COLUMN "feature" jsonb;
--> statement-breakpoint
UPDATE "identity_samples" AS samples
SET "model_version" = features."model_version",
    "processing_version" = features."processing_version",
    "feature" = features."feature"
FROM "identity_features" AS features
WHERE samples."id" = features."sample_id";
--> statement-breakpoint
ALTER TABLE "identity_samples" ALTER COLUMN "model_version" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "identity_samples" ALTER COLUMN "processing_version" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "identity_samples" ALTER COLUMN "feature" SET NOT NULL;
--> statement-breakpoint
DROP TABLE "identity_features";
