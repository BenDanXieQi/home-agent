CREATE TABLE "household_directories" (
	"account_id" text NOT NULL,
	"home_id" text NOT NULL,
	"directory" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_directories_account_id_home_id_pk" PRIMARY KEY("account_id","home_id")
);
