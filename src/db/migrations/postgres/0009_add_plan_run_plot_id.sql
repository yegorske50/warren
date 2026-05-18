ALTER TABLE "plan_runs" ADD COLUMN "plot_id" text;--> statement-breakpoint
CREATE INDEX "plan_runs_plot_id_idx" ON "plan_runs" USING btree ("plot_id");