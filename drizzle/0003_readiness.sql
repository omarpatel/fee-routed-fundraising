DROP INDEX `tokens_mint_idx`;--> statement-breakpoint
ALTER TABLE `tokens` ADD `superseded_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_mint_idx` ON `tokens` (`mint`) WHERE "tokens"."route_locked" = 1;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `funding_recovered_at` integer;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `funding_recovery_tx_sig` text;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `funding_recovered_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `funding_last_valid_block_height` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_recovery_tx_idx` ON `deliveries` (`funding_recovery_tx_sig`);--> statement-breakpoint
ALTER TABLE `wallet_transfers` ADD `last_valid_block_height` integer;