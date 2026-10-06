ALTER TABLE "automation_reviews" ADD COLUMN "automation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_reviews" ADD COLUMN "node_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_reviews" ADD CONSTRAINT "automation_reviews_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_reviews_node_idx" ON "automation_reviews" USING btree ("automation_id","node_id");--> statement-breakpoint
ALTER TABLE "automation_reviews" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "automation_reviews" DROP COLUMN "definition";--> statement-breakpoint
ALTER TABLE "automation_reviews" DROP COLUMN "matched";