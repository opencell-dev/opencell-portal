CREATE TABLE `agreement_acceptances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`version` integer NOT NULL,
	`accepted_at` integer NOT NULL,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agreement_acceptances_user_version` ON `agreement_acceptances` (`user_id`,`version`);--> statement-breakpoint
CREATE TABLE `issued_certs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`serial` text NOT NULL,
	`fpr` text NOT NULL,
	`cn` text NOT NULL,
	`not_before` integer NOT NULL,
	`not_after` integer NOT NULL,
	`pem` text NOT NULL,
	`pinned` integer NOT NULL,
	`issued_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issued_certs_fpr_unique` ON `issued_certs` (`fpr`);--> statement-breakpoint
CREATE INDEX `issued_certs_node` ON `issued_certs` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_downtime` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `node_downtime_node` ON `node_downtime` (`node_id`,`ends_at`);--> statement-breakpoint
CREATE TABLE `node_request_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`author_id` integer,
	`from_admin` integer NOT NULL,
	`body` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `node_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `node_request_messages_request` ON `node_request_messages` (`request_id`);--> statement-breakpoint
CREATE TABLE `node_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`site_name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`region` text NOT NULL,
	`pi_model` text NOT NULL,
	`w12_boards` integer NOT NULL,
	`gps` integer NOT NULL,
	`antenna` text NOT NULL,
	`backhaul` text NOT NULL,
	`power` text NOT NULL,
	`contact_phone` text NOT NULL,
	`agreement_version` integer NOT NULL,
	`agreed_at` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` integer,
	`decline_note` text,
	`node_id` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `node_requests_status` ON `node_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `node_requests_user` ON `node_requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `node_state` (
	`node_id` integer PRIMARY KEY NOT NULL,
	`online` integer,
	`last_heard_at` integer,
	`online_since` integer,
	`offline_since` integer,
	`offline_alert_at` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`user_id` integer,
	`core_id` text NOT NULL,
	`cell_id` integer NOT NULL,
	`cell_name` text NOT NULL,
	`cert_cn` text NOT NULL,
	`site_name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`region` text NOT NULL,
	`contact_phone` text NOT NULL,
	`anchor` integer NOT NULL,
	`cell_seed` integer NOT NULL,
	`board_role` text NOT NULL,
	`mode` text NOT NULL,
	`list_group` integer NOT NULL,
	`created_at` integer NOT NULL,
	`cert_fpr` text,
	`cert_issued_at` integer,
	`cert_expires_at` integer,
	`revoked_at` integer,
	`alerts_muted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_core_cell` ON `nodes` (`core_id`,`cell_id`);--> statement-breakpoint
CREATE INDEX `nodes_user` ON `nodes` (`user_id`);--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`csr_tries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `setup_tokens_node` ON `setup_tokens` (`node_id`);--> statement-breakpoint
ALTER TABLE `numbers` ADD `disabled_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_by` integer;