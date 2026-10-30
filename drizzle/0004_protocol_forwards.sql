CREATE TABLE `protocol_forwards` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_sig` text NOT NULL,
	`claimed_lamports` text NOT NULL,
	`forward_lamports` text NOT NULL,
	`to_address` text NOT NULL,
	`tx_sig` text,
	`last_valid_block_height` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_forwards_claim_idx` ON `protocol_forwards` (`claim_sig`);--> statement-breakpoint
CREATE INDEX `protocol_forwards_status_idx` ON `protocol_forwards` (`status`);