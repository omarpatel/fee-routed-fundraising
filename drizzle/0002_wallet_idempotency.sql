ALTER TABLE `wallet_transfers` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_transfers_idem_idx` ON `wallet_transfers` (`user_id`,`idempotency_key`);