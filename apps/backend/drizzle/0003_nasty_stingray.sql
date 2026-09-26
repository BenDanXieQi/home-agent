CREATE TABLE "mijia_home_selections" (
	"account_key" text PRIMARY KEY NOT NULL,
	"home_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
