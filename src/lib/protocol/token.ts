/**
 * $ROUTE tokenomics — the split of the creator share of trading fees. No team share.
 *
 * $ROUTE is launched on pump.fun with the protocol treasury as the token's creator, so pump.fun
 * pays 100% of the creator share to the treasury. pump.fun's own platform cut is taken before the
 * creator share exists and is not represented here. The split below is applied by the treasury
 * after the fact (the Commons share is forwarded to the Commons vault's route address) and is a
 * published policy, not an on-chain fee-share config.
 */
export const PROTOCOL_SPLIT = {
  /** Commons vault: matches deliveries of vaults that launch under Fee Router. Forwarded to the Commons vault's route address. */
  commonsBps: 5000,
  /** Protocol treasury: operator costs, verification, rails integration. Stays in the treasury. */
  treasuryBps: 5000,
} as const;

export const PROTOCOL_TOKEN = { name: "Fee Router", symbol: "ROUTE" } as const;

/** Sanity: the split must consume the whole creator share. */
const total = PROTOCOL_SPLIT.commonsBps + PROTOCOL_SPLIT.treasuryBps;
if (total !== 10000) throw new Error(`PROTOCOL_SPLIT must sum to 10000 bps, got ${total}`);

/** Default dev buy for the $ROUTE launch, SOL, spent by the treasury on the curve. */
export const PROTOCOL_DEFAULT_DEV_BUY_SOL = 0.5;
/** The launch needs at least this much SOL in the admin wallet: dev buy + rent + fees (raised to the dev buy when larger). */
export const PROTOCOL_LAUNCH_MIN_SOL = 0.1;
