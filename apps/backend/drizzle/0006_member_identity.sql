CREATE TABLE "identity_features" (
	"sample_id" uuid PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"processing_version" text NOT NULL,
	"feature" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_members" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_reference_state" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"content_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"eligibility_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "identity_reference_state_singleton" CHECK ("identity_reference_state"."id" = 'current')
);
--> statement-breakpoint
CREATE TABLE "identity_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"image_key" uuid NOT NULL,
	"image_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"source" jsonb NOT NULL,
	"quality" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_samples_image_key_unique" UNIQUE("image_key"),
	CONSTRAINT "identity_samples_member_sha256_unique" UNIQUE("member_id","sha256"),
	CONSTRAINT "identity_samples_bytes_positive" CHECK ("identity_samples"."image_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "identity_features" ADD CONSTRAINT "identity_features_sample_id_identity_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."identity_samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_members" ADD CONSTRAINT "identity_members_member_id_household_subjects_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."household_subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_samples" ADD CONSTRAINT "identity_samples_member_id_identity_members_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."identity_members"("member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_samples_member_idx" ON "identity_samples" USING btree ("member_id");