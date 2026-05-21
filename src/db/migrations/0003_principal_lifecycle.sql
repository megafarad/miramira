ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_disabled_at_idx" ON "users" USING btree ("disabled_at") WHERE "users"."disabled_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_deleted_at_idx" ON "users" USING btree ("deleted_at") WHERE "users"."deleted_at" IS NOT NULL;