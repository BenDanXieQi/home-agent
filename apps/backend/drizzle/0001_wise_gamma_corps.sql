CREATE TABLE "credentials" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
