import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "@/lib/env";

export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_FEE_PROGRAM_ID = "FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK";
/** PumpSwap AMM: creator fees of graduated pump.fun tokens are collected here. */
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
/** Programs whose outflows to a route address count as creator fees. */
export const FEE_SOURCE_PROGRAMS: Record<string, true> = { [PUMPFUN_PROGRAM_ID]: true, [PUMP_FEE_PROGRAM_ID]: true };
/** Jupiter aggregator v6: the program Swap API v1 transactions (the sweep) execute on. */
export const JUPITER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const g = globalThis as unknown as { __feeRouterRpc?: Connection };

/** One Connection per process. Falls back to the rate-limited public endpoint for reads. */
export function rpc(): Connection {
  if (!g.__feeRouterRpc) g.__feeRouterRpc = new Connection(env.SOLANA_RPC_URL ?? PUBLIC_MAINNET_RPC, { commitment: "confirmed" });
  return g.__feeRouterRpc;
}

export function isValidAddress(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function toUsdcRaw(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
}

export function fromUsdcRaw(raw: bigint | string | number): number {
  return Number(BigInt(raw)) / 10 ** USDC_DECIMALS;
}
