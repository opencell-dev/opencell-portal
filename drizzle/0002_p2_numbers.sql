CREATE TABLE `exchanges` (
	`npa_nxx` text PRIMARY KEY NOT NULL,
	`npa` text NOT NULL,
	`nxx` text NOT NULL,
	`region` text NOT NULL,
	`rate_center` text NOT NULL,
	`ocn` text,
	`company` text,
	`first_seen_at` integer NOT NULL,
	`withdrawn_at` integer
);
--> statement-breakpoint
CREATE INDEX `exchanges_place` ON `exchanges` (`region`,`rate_center`);--> statement-breakpoint
CREATE INDEX `exchanges_npa` ON `exchanges` (`npa`);--> statement-breakpoint
CREATE INDEX `exchanges_rc` ON `exchanges` (`rate_center`);--> statement-breakpoint
CREATE TABLE `limit_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`reason` text NOT NULL,
	`wanted` integer NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` integer,
	`outcome` text,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `limit_requests_user` ON `limit_requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `nanpa_refreshes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`ok` integer NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `npas` (
	`npa` text PRIMARY KEY NOT NULL,
	`region` text NOT NULL,
	`geographic` integer NOT NULL,
	`in_service` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `numbers` (
	`number` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`core_id` text NOT NULL,
	`listed` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`token_expires_at` integer,
	`state` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`registered` integer DEFAULT false NOT NULL,
	`cell_id` integer,
	`tmid_prefix` text,
	`last_seen_at` integer,
	`status_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `numbers_user` ON `numbers` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_centers` (
	`region` text NOT NULL,
	`name` text NOT NULL,
	`display` text NOT NULL,
	`lat` real,
	`lon` real,
	PRIMARY KEY(`region`, `name`)
);
