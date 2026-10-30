import { BagsSDK, BAGS_FEE_SHARE_V2_PROGRAM_ID } from "@bagsfm/bags-sdk";
import { PublicKey } from "@solana/web3.js";
import { configured, env } from "@/lib/env";
import { rpc } from "@/lib/solana/rpc";

/**
 * Bags is a *connect* source only: an existing Bags token routes fees to Fee Router by naming the route
 * address as a fee-share claimer, and `verifyRoute` reads that config here. Launches happen on
 * pump.fun (see ./pumpfun.ts).
 */

/** The SDK pins its own @solana/web3.js copy; its Connection class is structurally identical to ours. */
type BagsConnection = ConstructorParameters<typeof BagsSDK>[1];

export const BAGS_NOT_CONFIGURED = "Bags not configured";

let sdk: BagsSDK | null = null;
function bags(): BagsSDK {
  if (!configured.bags) throw new Error(BAGS_NOT_CONFIGURED);
  if (!sdk) {
    const conn = rpc() as unknown as BagsConnection;
    sdk = new BagsSDK(env.BAGS_API_KEY!, conn, "confirmed");
  }
  return sdk;
}

export { BAGS_FEE_SHARE_V2_PROGRAM_ID };

export interface BagsClaimer {
  wallet: string;
  bps: number;
}

/** Fee-share claimers for a Bags token, or null when Bags is not configured / the token is unknown to Bags. */
export async function getBagsFeeShareClaimers(mint: string): Promise<BagsClaimer[] | null> {
  if (!configured.bags) return null;
  try {
    const creators = await bags().state.getTokenCreators(new PublicKey(mint));
    return creators.map((c) => ({ wallet: c.wallet, bps: c.royaltyBps }));
  } catch (e) {
    console.warn(`[bags] getTokenCreators failed for ${mint}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
