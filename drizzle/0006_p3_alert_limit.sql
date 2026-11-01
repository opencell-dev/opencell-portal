ALTER TABLE `node_state` ADD `alerts_held` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `node_state` ADD `alert_held_at` integer;