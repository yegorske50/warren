ALTER TABLE "runs" ADD COLUMN "plot_id" text;--> statement-breakpoint
CREATE INDEX "runs_plot_id_idx" ON "runs" USING btree ("plot_id");