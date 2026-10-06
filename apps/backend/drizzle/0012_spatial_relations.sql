CREATE TABLE "observation_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"channel" integer,
	"space_id" uuid,
	"passage_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_bindings_one_target" CHECK (("observation_bindings"."space_id" is null) <> ("observation_bindings"."passage_id" is null)),
	CONSTRAINT "observation_bindings_device_nonempty" CHECK (length(btrim("observation_bindings"."device_id")) > 0),
	CONSTRAINT "observation_bindings_channel" CHECK ("observation_bindings"."channel" is null or "observation_bindings"."channel" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "passages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"space_a_id" uuid NOT NULL,
	"space_b_id" uuid NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passages_name_nonempty" CHECK (length(btrim("passages"."name")) > 0),
	CONSTRAINT "passages_endpoints_differ" CHECK ("passages"."space_a_id" <> "passages"."space_b_id")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_name_nonempty" CHECK (length(btrim("spaces"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "observation_bindings" ADD CONSTRAINT "observation_bindings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_bindings" ADD CONSTRAINT "observation_bindings_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "public"."passages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_space_a_id_spaces_id_fk" FOREIGN KEY ("space_a_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_space_b_id_spaces_id_fk" FOREIGN KEY ("space_b_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_bindings_space_idx" ON "observation_bindings" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "observation_bindings_passage_idx" ON "observation_bindings" USING btree ("passage_id");--> statement-breakpoint
CREATE INDEX "passages_space_a_idx" ON "passages" USING btree ("space_a_id");--> statement-breakpoint
CREATE INDEX "passages_space_b_idx" ON "passages" USING btree ("space_b_id");