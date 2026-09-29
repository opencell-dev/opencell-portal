ALTER TABLE `challenges` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `uv` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `credential_id` text;