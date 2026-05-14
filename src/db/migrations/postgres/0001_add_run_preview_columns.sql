ALTER TABLE "runs" ADD COLUMN "preview_state" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preview_port" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preview_started_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preview_last_hit_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "preview_failure_message" text;