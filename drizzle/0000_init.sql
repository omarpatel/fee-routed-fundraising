CREATE TABLE `causes` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`story` text NOT NULL,
	`beneficiary` text NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`onchain_address` text,
	`goal_usd` real,
	`raised_external_usd` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`image_url` text,
	`location` text,
	`category` text DEFAULT 'medical' NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`verification_note` text,
	`verified_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `causes_slug_idx` ON `causes` (`slug`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`ordinal` integer NOT NULL,
	`vault_id` text NOT NULL,
	`cause_id` text NOT NULL,
	`period_id` text,
	`rail` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`amount_usdc` real NOT NULL,
	`amount_fiat` real,
	`fiat_currency` text,
	`fx_rate` real,
	`platform_fee_fiat` real,
	`funding_tx_sig` text,
	`rail_ref` text,
	`bridge_id` text,
	`bridge_deposit_address` text,
	`bridge_amount_usdc` real,
	`bridge_expires_at` integer,
	`bridge_status` text,
	`card_tx_id` text,
	`card_tx_merchant` text,
	`card_tx_at` integer,
	`notified_at` integer,
	`receipt_hash` text,
	`anchor_tx_sig` text,
	`executed_by_user_id` text,
	`notes` text,
	`failure_reason` text,
	`queued_at` integer NOT NULL,
	`funded_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cause_id`) REFERENCES `causes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`executed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_vault_ordinal_idx` ON `deliveries` (`vault_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `deliveries_status_idx` ON `deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `deliveries_cause_idx` ON `deliveries` (`cause_id`);--> statement-breakpoint
CREATE TABLE `delivery_allocations` (
	`delivery_id` text NOT NULL,
	`token_id` text NOT NULL,
	`amount_usdc` real NOT NULL,
	PRIMARY KEY(`delivery_id`, `token_id`),
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fee_events` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`token_id` text NOT NULL,
	`tx_sig` text NOT NULL,
	`slot` integer NOT NULL,
	`block_time` integer NOT NULL,
	`asset_mint` text NOT NULL,
	`amount_raw` text NOT NULL,
	`decimals` integer NOT NULL,
	`amount_usd` real NOT NULL,
	`kind` text NOT NULL,
	`sweep_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fee_events_sig_idx` ON `fee_events` (`tx_sig`,`asset_mint`);--> statement-breakpoint
CREATE INDEX `fee_events_vault_time_idx` ON `fee_events` (`vault_id`,`block_time`);--> statement-breakpoint
CREATE INDEX `fee_events_token_idx` ON `fee_events` (`token_id`);--> statement-breakpoint
CREATE TABLE `google_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `keys` (
	`address` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`owner_id` text NOT NULL,
	`secret_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `launches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`token_id` text,
	`launchpad` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `periods` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`label` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`fees_usd` real DEFAULT 0 NOT NULL,
	`delivered_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `periods_vault_idx` ON `periods` (`vault_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `protocol_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `protocol_fee_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tx_sig` text NOT NULL,
	`slot` integer NOT NULL,
	`block_time` integer NOT NULL,
	`asset_mint` text NOT NULL,
	`amount_raw` text NOT NULL,
	`decimals` integer NOT NULL,
	`amount_usd` real NOT NULL,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocol_fee_sig_idx` ON `protocol_fee_events` (`tx_sig`,`asset_mint`);--> statement-breakpoint
CREATE INDEX `protocol_fee_time_idx` ON `protocol_fee_events` (`block_time`);--> statement-breakpoint
CREATE TABLE `receipt_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_delivery_idx` ON `receipt_artifacts` (`delivery_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sweeps` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`token_id` text NOT NULL,
	`tx_sig` text NOT NULL,
	`input_mint` text NOT NULL,
	`input_amount_raw` text NOT NULL,
	`output_usdc_raw` text NOT NULL,
	`rate` real NOT NULL,
	`slippage_bps` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sweeps_sig_idx` ON `sweeps` (`tx_sig`);--> statement-breakpoint
CREATE INDEX `sweeps_vault_idx` ON `sweeps` (`vault_id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`mint` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`image_url` text,
	`source` text NOT NULL,
	`launchpad_url` text,
	`creator_wallet` text,
	`route_address` text NOT NULL,
	`route_bps` integer DEFAULT 10000 NOT NULL,
	`route_locked` integer DEFAULT false NOT NULL,
	`route_proof_tx` text,
	`launched_via_fee_router` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_mint_idx` ON `tokens` (`mint`);--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_route_idx` ON `tokens` (`route_address`);--> statement-breakpoint
CREATE INDEX `tokens_vault_idx` ON `tokens` (`vault_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`name` text,
	`avatar_url` text,
	`wallet_address` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_idx` ON `users` (`google_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_wallet_idx` ON `users` (`wallet_address`);--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text,
	`cause_id` text NOT NULL,
	`owner_user_id` text,
	`treasury_address` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`donate_bps` integer DEFAULT 10000 NOT NULL,
	`delivery_threshold_usd` real DEFAULT 250 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`cause_id`) REFERENCES `causes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vaults_slug_idx` ON `vaults` (`slug`);--> statement-breakpoint
CREATE INDEX `vaults_cause_idx` ON `vaults` (`cause_id`);--> statement-breakpoint
CREATE TABLE `wallet_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`asset_mint` text NOT NULL,
	`amount_raw` text NOT NULL,
	`to_address` text NOT NULL,
	`tx_sig` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `wallet_transfers_user_idx` ON `wallet_transfers` (`user_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload` text NOT NULL,
	`processed_at` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_dedupe_key_unique` ON `webhook_events` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `zentro_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_enc` text NOT NULL,
	`card_id` text,
	`last4` text,
	`last_ok_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
