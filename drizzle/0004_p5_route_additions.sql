CREATE TABLE `route_additions` (
	`root_version` integer NOT NULL,
	`seq` integer NOT NULL,
	`blob` blob NOT NULL,
	`sig` blob NOT NULL,
	`npas` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`root_version`, `seq`)
);
