DROP INDEX "outbox_events_pending_idx";--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbox_events_dead_idx" ON "outbox_events" USING btree ("dead_at") WHERE "outbox_events"."dead_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("next_retry_at") WHERE "outbox_events"."processed_at" IS NULL AND "outbox_events"."dead_at" IS NULL;