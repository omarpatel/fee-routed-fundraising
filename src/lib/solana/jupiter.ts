import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { configured, env } from "@/lib/env";
import { SOL_MINT, USDC_MINT, rpc } from "./rpc";

const JUP_SWAP_URL = "https://api.jup.ag/swap/v1";

export interface SwapResult {
  sig: string;
  outAmountRaw: string;
  /** USDC (whole units) per whole unit of input. */
  rate: number;
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  routePlan: unknown[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (env.JUPITER_API_KEY) h["x-api-key"] = env.JUPITER_API_KEY;
  return h;
}

/**
 * Swap `amountRaw` of `inputMint` held by `keypair` into USDC via Jupiter Swap API v1.
 * Requires JUPITER_API_KEY (api.jup.ag rejects unauthenticated swap builds) and a write-capable RPC.
 */
export async function swapToUsdc(keypair: Keypair, inputMint: string, amountRaw: bigint | string, slippageBps = 100, inputDecimals?: number): Promise<SwapResult> {
  if (!configured.jupiter) throw new Error("Jupiter not configured (JUPITER_API_KEY)");
  const amount = BigInt(amountRaw).toString();
  const q = new URLSearchParams({ inputMint, outputMint: USDC_MINT.toBase58(), amount, slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  const quoteRes = await fetch(`${JUP_SWAP_URL}/quote?${q}`, { headers: headers(), cache: "no-store" });
  if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = (await quoteRes.json()) as JupQuote;

  const swapRes = await fetch(`${JUP_SWAP_URL}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: keypair.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" } } }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap ${swapRes.status}: ${await swapRes.text()}`);
  const { swapTransaction, lastValidBlockHeight } = (await swapRes.json()) as { swapTransaction: string; lastValidBlockHeight: number };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);
  const conn = rpc();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const blockhash = tx.message.recentBlockhash;
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Jupiter swap failed on-chain: ${JSON.stringify(conf.value.err)}`);

  const decimals = inputDecimals ?? (await mintDecimals(inputMint));
  const inUi = Number(BigInt(quote.inAmount)) / 10 ** decimals;
  const outUi = Number(BigInt(quote.outAmount)) / 1e6;
  return { sig, outAmountRaw: quote.outAmount, rate: inUi > 0 ? outUi / inUi : 0 };
}

export async function mintDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const info = await rpc().getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data;
  if (!data || !("parsed" in data)) throw new Error(`Cannot read decimals for mint ${mint}`);
  const decimals: unknown = data.parsed?.info?.decimals;
  if (typeof decimals !== "number") throw new Error(`Cannot read decimals for mint ${mint}`);
  return decimals;
}
