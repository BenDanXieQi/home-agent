SELECT pg_advisory_xact_lock(hashtextextended('household_binding', 0));
--> statement-breakpoint
CREATE TABLE "device_history_state" (
	"device_id" text NOT NULL,
	"item" text NOT NULL,
	"value" jsonb NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "device_history_state_device_id_item_pk" PRIMARY KEY("device_id","item"),
	CONSTRAINT "device_history_state_device_nonempty" CHECK (length("device_history_state"."device_id") > 0),
	CONSTRAINT "device_history_state_value_scalar" CHECK (jsonb_typeof("device_history_state"."value") IN ('number', 'boolean', 'string', 'null')),
	CONSTRAINT "device_history_state_item" CHECK (("device_history_state"."item" = 'online' AND jsonb_typeof("device_history_state"."value") = 'boolean' AND "device_history_state"."metadata" IS NULL)
      OR ("device_history_state"."item" ~ '^[1-9][0-9]*[.][1-9][0-9]*$' AND "device_history_state"."metadata" IS NOT NULL AND jsonb_typeof("device_history_state"."metadata") = 'object'))
);
