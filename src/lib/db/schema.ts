import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Fee Router ledger schema.
 *
 * Money flows in exactly one direction and every hop is a row:
 *   fee_events  (fees land on a token's route address, attributed by address)
 *   → sweeps     (route address → vault treasury, converted to USDC via Jupiter)
 *   → deliveries (vault treasury → a rail → the cause), with pro-rata token allocations
 *   → receipts   (hash of evidence bundle anchored on-chain as a memo tx)
 *
 * Amounts: raw on-chain integers are stored as TEXT (bigint-safe). USD values are REAL,
 * rounded to cents at the boundary, never used for on-chain math.
 */

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Google account subject (`sub` claim). Stable across email changes. */
    googleSub: text("google_sub").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** Custodial Solana wallet (key in `keys`, purpose `user_wallet`). Created at first sign-in. */
    walletAddress: text("wallet_address").notNull(),
    role: text("role", { enum: ["user", "operator", "admin"] }).notNull().default("user"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("users_google_sub_idx").on(t.googleSub), uniqueIndex("users_email_idx").on(t.email), uniqueIndex("users_wallet_idx").on(t.walletAddress)],
);

/** Server sessions. Cookie carries the opaque `id`; `tokenHash` is sha256 of the cookie secret. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/**
 * Google OAuth refresh tokens for elevated scopes (operators: gmail.readonly + gmail.send so the
 * system can harvest donation confirmations and send runbook notifications). Encrypted under KMS.
 */
export const googleTokens = sqliteTable("google_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  scopes: text("scopes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Zentro CardHub session (cookie + client X25519 key pair), encrypted under KMS. Single row. */
export const zentroSessions = sqliteTable("zentro_sessions", {
  id: text("id").primaryKey(),
  sessionEnc: text("session_enc").notNull(),
  cardId: text("card_id"),
  last4: text("last4"),
  lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const CAUSE_PLATFORMS = ["gofundme", "launchgood", "justgiving", "gogetfunding", "everyorg", "stripe_link", "onchain", "other"] as const;
export type CausePlatform = (typeof CAUSE_PLATFORMS)[number];

export const causes = sqliteTable(
  "causes",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    story: text("story").notNull(),
    beneficiary: text("beneficiary").notNull(),
    platform: text("platform", { enum: CAUSE_PLATFORMS }).notNull(),
    url: text("url").notNull(),
    /** For `onchain` causes: the USDC recipient address. */
    onchainAddress: text("onchain_address"),
    goalUsd: real("goal_usd"),
    raisedExternalUsd: real("raised_external_usd"),
    currency: text("currency").notNull().default("USD"),
    imageUrl: text("image_url"),
    location: text("location"),
    category: text("category").notNull().default("medical"),
    verificationStatus: text("verification_status", { enum: ["unverified", "pending", "verified", "rejected"] })
      .notNull()
      .default("unverified"),
    verificationNote: text("verification_note"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("causes_slug_idx").on(t.slug)],
);

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    causeId: text("cause_id")
      .notNull()
      .references(() => causes.id),
    ownerUserId: text("owner_user_id").references(() => users.id),
    /** Vault USDC treasury (custodial keypair, secret encrypted in `keys`). */
    treasuryAddress: text("treasury_address").notNull(),
    status: text("status", { enum: ["active", "paused", "closed"] }).notNull().default("active"),
    /** Portion of swept fees that must be delivered to the cause. Rest stays for gas/ops. */
    donateBps: integer("donate_bps").notNull().default(10000),
    /** Deliveries auto-queue once treasury USDC >= this. */
    deliveryThresholdUsd: real("delivery_threshold_usd").notNull().default(250),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("vaults_slug_idx").on(t.slug), index("vaults_cause_idx").on(t.causeId)],
);

export const TOKEN_SOURCES = ["pumpfun", "bags", "meteora", "manual"] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    mint: text("mint").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    imageUrl: text("image_url"),
    source: text("source", { enum: TOKEN_SOURCES }).notNull(),
    launchpadUrl: text("launchpad_url"),
    creatorWallet: text("creator_wallet"),
    /** Dedicated fee-recipient address for this token. Attribution = this address. */
    routeAddress: text("route_address").notNull(),
    /** Basis points of the token's creator fees pointed at routeAddress. */
    routeBps: integer("route_bps").notNull().default(10000),
    /** Route is on-chain-immutable (pump.fun one-time redirect, Bags config). */
    routeLocked: integer("route_locked", { mode: "boolean" }).notNull().default(false),
    routeProofTx: text("route_proof_tx"),
    /** Launched through Fee Router (vs. connected after the fact). */
    launchedViaFeeRouter: integer("launched_via_fee_router", { mode: "boolean" }).notNull().default(false),
    /**
     * Another connection of the same mint locked its route (proved it is the creator's): this
     * unverified row is no longer the mint's connection. Kept only because fee events are
     * attributed to it; never listed, verified or connected against.
     */
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  // A mint may be connected by several vaults until one proves its route; only a locked route owns the mint.
  (t) => [uniqueIndex("tokens_mint_idx").on(t.mint).where(sql`${t.routeLocked} = 1`), uniqueIndex("tokens_route_idx").on(t.routeAddress), index("tokens_vault_idx").on(t.vaultId)],
);

export const feeEvents = sqliteTable(
  "fee_events",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id),
    txSig: text("tx_sig").notNull(),
    slot: integer("slot").notNull(),
    blockTime: integer("block_time", { mode: "timestamp_ms" }).notNull(),
    /** Asset received on the route address. "SOL" or an SPL mint. */
    assetMint: text("asset_mint").notNull(),
    amountRaw: text("amount_raw").notNull(),
    decimals: integer("decimals").notNull(),
    /** USD value at block time (price oracle snapshot). */
    amountUsd: real("amount_usd").notNull(),
    kind: text("kind", { enum: ["creator_fee", "fee_claim", "transfer", "tip"] }).notNull(),
    /** Set once the sweep that consumed this event is recorded. */
    sweepId: text("sweep_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("fee_events_sig_idx").on(t.txSig, t.assetMint), index("fee_events_vault_time_idx").on(t.vaultId, t.blockTime), index("fee_events_token_idx").on(t.tokenId)],
);

export const sweeps = sqliteTable(
  "sweeps",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id),
    /** Jupiter swap tx (route address asset → USDC) or plain transfer if already USDC. */
    txSig: text("tx_sig").notNull(),
    inputMint: text("input_mint").notNull(),
    inputAmountRaw: text("input_amount_raw").notNull(),
    outputUsdcRaw: text("output_usdc_raw").notNull(),
    /** USDC per unit of input, at execution. */
    rate: real("rate").notNull(),
    slippageBps: integer("slippage_bps").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("sweeps_sig_idx").on(t.txSig), index("sweeps_vault_idx").on(t.vaultId)],
);

export const RAILS = ["operator_card", "onchain", "stripe_link", "gofundme_pro", "issuing_card"] as const;
export type Rail = (typeof RAILS)[number];

/**
 * queued → funding (invoice created, USDC sent, waiting for the card to credit)
 *        → funded (card credited; operator notified)
 *        → executing (purchase detected on the card; harvesting evidence)
 *        → delivered (receipt hashed + anchored)
 */
export const DELIVERY_STATUSES = ["queued", "funding", "funded", "executing", "delivered", "failed", "reversed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    /** Human-facing sequential number per vault, printed on the receipt. */
    ordinal: integer("ordinal").notNull(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    causeId: text("cause_id")
      .notNull()
      .references(() => causes.id),
    periodId: text("period_id").references(() => periods.id),
    rail: text("rail", { enum: RAILS }).notNull(),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull().default("queued"),
    amountUsdc: real("amount_usdc").notNull(),
    amountFiat: real("amount_fiat"),
    fiatCurrency: text("fiat_currency"),
    fxRate: real("fx_rate"),
    platformFeeFiat: real("platform_fee_fiat"),
    /** USDC transfer from treasury to the rail (Zentro top-up address, recipient, etc.). Set on a failed/reversed row = the USDC left the treasury (stranded, until recovered). */
    fundingTxSig: text("funding_tx_sig"),
    /**
     * Stranded funding returned to the treasury: the operator-cited transfer, checked on-chain to
     * credit the vault treasury at least the delivery amount. The row keeps its failed/reversed
     * status; it just stops counting against the deliverable balance.
     */
    fundingRecoveredAt: integer("funding_recovered_at", { mode: "timestamp_ms" }),
    fundingRecoveryTxSig: text("funding_recovery_tx_sig"),
    fundingRecoveredBy: text("funding_recovered_by").references(() => users.id),
    /**
     * Last block height at which the funding transfer can land. Written with the signature before
     * broadcast and cleared once the transfer is confirmed, so on a `funding` row it means "sent,
     * not known to have landed": the worker settles it from the chain.
     */
    fundingLastValidBlockHeight: integer("funding_last_valid_block_height"),
    /** Rail-specific reference: card last4 + auth code, on-chain tx, Stripe payment id. */
    railRef: text("rail_ref"),
    /** operator_card: Zentro top-up invoice. */
    bridgeId: text("bridge_id"),
    bridgeDepositAddress: text("bridge_deposit_address"),
    bridgeAmountUsdc: real("bridge_amount_usdc"),
    bridgeExpiresAt: integer("bridge_expires_at", { mode: "timestamp_ms" }),
    bridgeStatus: text("bridge_status"),
    /** operator_card: Zentro purchase matched by the reconciler. */
    cardTxId: text("card_tx_id"),
    cardTxMerchant: text("card_tx_merchant"),
    cardTxAt: integer("card_tx_at", { mode: "timestamp_ms" }),
    /** Notification sent to the operator asking for the tap. */
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
    /** sha256 over the canonical receipt bundle (see lib/proof). */
    receiptHash: text("receipt_hash"),
    /** Solana memo tx carrying `fee-router:v1:<deliveryId>:<receiptHash>`. */
    anchorTxSig: text("anchor_tx_sig"),
    executedByUserId: text("executed_by_user_id").references(() => users.id),
    notes: text("notes"),
    failureReason: text("failure_reason"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    fundedAt: integer("funded_at", { mode: "timestamp_ms" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("deliveries_vault_ordinal_idx").on(t.vaultId, t.ordinal),
    uniqueIndex("deliveries_card_tx_idx").on(t.cardTxId),
    // One refund can only recover one stranded delivery.
    uniqueIndex("deliveries_recovery_tx_idx").on(t.fundingRecoveryTxSig),
    index("deliveries_status_idx").on(t.status),
    index("deliveries_cause_idx").on(t.causeId),
  ],
);

/** Which token funded how much of a delivery. Sum over a delivery == amountUsdc. */
export const deliveryAllocations = sqliteTable(
  "delivery_allocations",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id),
    amountUsdc: real("amount_usdc").notNull(),
  },
  (t) => [primaryKey({ columns: [t.deliveryId, t.tokenId] })],
);

/** Evidence attached to a delivery. Files live in object storage; only hashes are canonical. */
export const receiptArtifacts = sqliteTable(
  "receipt_artifacts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    kind: text("kind", { enum: ["screenshot", "confirmation_email", "card_statement", "platform_receipt", "onchain_tx", "other"] }).notNull(),
    label: text("label").notNull(),
    url: text("url").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("artifacts_delivery_idx").on(t.deliveryId)],
);

/** Reporting window. Public vault pages show fees in / delivered out per period. */
export const periods = sqliteTable(
  "periods",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id),
    label: text("label").notNull(),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", { enum: ["open", "closing", "closed"] }).notNull().default("open"),
    feesUsd: real("fees_usd").notNull().default(0),
    deliveredUsd: real("delivered_usd").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("periods_vault_idx").on(t.vaultId, t.startsAt)],
);

/** Custodial key material. `secretEnc` is AES-256-GCM(base64) under FEE_ROUTER_KMS_KEY. Never returned by any query. */
export const keys = sqliteTable("keys", {
  address: text("address").primaryKey(),
  purpose: text("purpose", { enum: ["vault_treasury", "token_route", "anchor_signer", "user_wallet", "protocol_treasury"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  secretEnc: text("secret_enc").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const launches = sqliteTable("launches", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  vaultId: text("vault_id")
    .notNull()
    .references(() => vaults.id),
  tokenId: text("token_id").references(() => tokens.id),
  launchpad: text("launchpad", { enum: ["bags", "pumpfun"] }).notNull(),
  /** `refunded`: the create never landed and recovery returned the funded SOL (see `src/lib/launchpads/recovery.ts`). */
  status: text("status", { enum: ["draft", "config_created", "launched", "failed", "refunded"] }).notNull().default("draft"),
  /** Launchpad-specific payload (fee share config id, tx sigs; for pump.fun also what recovery needs, see `LaunchMeta`). */
  meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Idempotent webhook inbox. */
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["helius"] }).notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Protocol treasury inflows: $ROUTE creator fees and anything else sent to the protocol address. */
export const protocolFeeEvents = sqliteTable(
  "protocol_fee_events",
  {
    id: text("id").primaryKey(),
    txSig: text("tx_sig").notNull(),
    slot: integer("slot").notNull(),
    blockTime: integer("block_time", { mode: "timestamp_ms" }).notNull(),
    assetMint: text("asset_mint").notNull(),
    amountRaw: text("amount_raw").notNull(),
    decimals: integer("decimals").notNull(),
    amountUsd: real("amount_usd").notNull(),
    source: text("source"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("protocol_fee_sig_idx").on(t.txSig, t.assetMint), index("protocol_fee_time_idx").on(t.blockTime)],
);

/**
 * The Commons share of one $ROUTE creator-fee claim on the protocol treasury, forwarded to the Commons
 * vault's route address. One row per claim transaction (`claimSig`); pending rows are batched into one
 * transfer whose signature and expiry height are written before broadcast (`sent`). A `sent` transfer
 * that failed or expired returns its rows to `pending` (nothing moved); one that landed is `confirmed`.
 * Lamport amounts are decimal strings (bigint-safe).
 */
export const protocolForwards = sqliteTable(
  "protocol_forwards",
  {
    id: text("id").primaryKey(),
    claimSig: text("claim_sig").notNull(),
    claimedLamports: text("claimed_lamports").notNull(),
    forwardLamports: text("forward_lamports").notNull(),
    /** The Commons route address. */
    toAddress: text("to_address").notNull(),
    txSig: text("tx_sig"),
    lastValidBlockHeight: integer("last_valid_block_height"),
    status: text("status", { enum: ["pending", "sent", "confirmed", "failed"] }).notNull().default("pending"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("protocol_forwards_claim_idx").on(t.claimSig), index("protocol_forwards_status_idx").on(t.status)],
);

/**
 * Custodial wallet outflows initiated by users (withdrawals) and by the system (launch fees). A
 * `launch_refund` row is the reverse of a failed launch's `launch_fee`: sent from the launch's creator
 * key back to `toAddress`, the launching user's wallet; its idempotency key is `launch_refund:<launchId>`.
 */
export const walletTransfers = sqliteTable(
  "wallet_transfers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: ["withdraw", "launch_fee", "launch_refund", "internal"] }).notNull(),
    assetMint: text("asset_mint").notNull(),
    amountRaw: text("amount_raw").notNull(),
    toAddress: text("to_address").notNull(),
    txSig: text("tx_sig"),
    /** Last block height at which `txSig` can land: a `sent` row past it with no trace on-chain never moved anything. */
    lastValidBlockHeight: integer("last_valid_block_height"),
    status: text("status", { enum: ["pending", "sent", "confirmed", "failed"] }).notNull().default("pending"),
    error: text("error"),
    /** Client-supplied per withdraw intent; a repeated key returns this row instead of sending again. Null for system transfers. */
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("wallet_transfers_user_idx").on(t.userId), uniqueIndex("wallet_transfers_idem_idx").on(t.userId, t.idempotencyKey)],
);

/** Singleton protocol settings (protocol treasury address, $ROUTE mint, launch state). */
export const protocolConfig = sqliteTable("protocol_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ProtocolFeeEvent = typeof protocolFeeEvents.$inferSelect;
export type WalletTransfer = typeof walletTransfers.$inferSelect;
export type Cause = typeof causes.$inferSelect;
export type Vault = typeof vaults.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type FeeEvent = typeof feeEvents.$inferSelect;
export type Sweep = typeof sweeps.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type DeliveryAllocation = typeof deliveryAllocations.$inferSelect;
export type ReceiptArtifact = typeof receiptArtifacts.$inferSelect;
export type Period = typeof periods.$inferSelect;
export type Launch = typeof launches.$inferSelect;
