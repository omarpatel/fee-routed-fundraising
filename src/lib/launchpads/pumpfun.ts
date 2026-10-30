import { Keypair, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { PUMPFUN_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, rpc } from "@/lib/solana/rpc";

const PUMPPORTAL_LOCAL = "https://pumpportal.fun/api/trade-local";
const PUMPFUN_IPFS = "https://pump.fun/api/ipfs";

export { PUMPFUN_PROGRAM_ID, PUMP_FEE_PROGRAM_ID };

/**
 * pump.fun pays creator fees to the token's *creator* wallet (bonding curve) and later to the
 * PumpSwap creator-fee vault. Fees accrue in a per-creator vault and are claimed with a
 * `collectCreatorFee` instruction.
 *
 * Two ways a token ends up routed to Fee Router:
 *
 *   1. Launched here (`createPumpToken`): the Fee Router route keypair *is* the creator and signs the
 *      create transaction, so fees accrue to the route address by construction. No redirect step,
 *      nothing the creator can later change; `tokens.routeLocked` is true from the first block.
 *
 *   2. Connected after the fact: the creator performs pump.fun's one-time redirect in its UI
 *      (Profile → Coin → "Creator rewards" → "Change fee recipient" → paste the route address).
 *      `set_creator` is one-shot, which is why `verifyRoute` locks the route once it observes the
 *      first inflow from 6EF8… / FEE2… onto the route address.
 *
 * Both are claimed the same way: `claimCreatorFees` builds `collectCreatorFee` for the route key,
 * signs with the custodial secret and sends it; the SOL lands on the route address and the normal
 * ingest/sweep path takes it from there.
 */

/** Rent for the mint, bonding curve and ATAs plus a few fees. On top of the dev buy. */
export const PUMP_CREATE_RESERVE_SOL = 0.03;
/** Base priority fee for the create transaction (PumpPortal takes it in SOL). */
const CREATE_PRIORITY_FEE_SOL = 0.0005;

export interface UnsignedTx {
  /** base64-serialized VersionedTransaction, unsigned. */
  transaction: string;
  /** The wallet that must sign. */
  signer: string;
}

/** Build the unsigned `collectCreatorFee` transaction via PumpPortal's local (non-custodial) API. */
export async function collectCreatorFeeTx(creatorWallet: string, priorityFeeSol = 0.00005): Promise<UnsignedTx> {
  const res = await fetch(PUMPPORTAL_LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: creatorWallet, action: "collectCreatorFee", priorityFee: priorityFeeSol }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PumpPortal ${res.status}: ${await res.text()}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { transaction: Buffer.from(bytes).toString("base64"), signer: creatorWallet };
}

/**
 * Worker helper: claim accrued creator fees for a custodial creator (a Fee Router route key or the
 * protocol treasury). Signs with the given keypair and confirms. Returns the signature, or null when
 * pump.fun reports nothing to claim (PumpPortal answers 400 in that case; the message is passed on
 * in `reason`).
 */
export async function claimCreatorFees(creator: Keypair): Promise<{ signature: string | null; reason?: string }> {
  let unsigned: UnsignedTx;
  try {
    unsigned = await collectCreatorFeeTx(creator.publicKey.toBase58());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/PumpPortal 400/.test(msg)) return { signature: null, reason: msg };
    throw e;
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(unsigned.transaction, "base64"));
  tx.sign([creator]);
  const conn = rpc();
  const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`collectCreatorFee ${signature} failed: ${JSON.stringify(conf.value.err)}`);
  return { signature };
}

export interface CreatePumpTokenInput {
  name: string;
  symbol: string;
  description: string;
  image: { bytes: Buffer; mime: string };
  website?: string;
  twitter?: string;
  telegram?: string;
  /** Signs the create tx, pays for it and the dev buy, and is the token's creator (fee recipient) forever. */
  creator: Keypair;
  /** SOL spent on the initial buy from the creator wallet. 0 = create only. */
  devBuySol: number;
  /**
   * Called with the signed create before it is broadcast; a throw aborts the launch with nothing sent.
   * The caller persists it so a create whose send or confirmation fails can still be resolved on-chain.
   */
  onSigned: (signed: SignedPumpCreate) => Promise<void>;
}

export interface SignedPumpCreate {
  mint: string;
  signature: string;
  /** The create can no longer land once the chain is past this block height. */
  lastValidBlockHeight: number;
  metadataUri: string;
}

export interface CreatePumpTokenResult {
  mint: string;
  metadataUri: string;
  imageUri: string;
  signature: string;
}

/**
 * Step 1 · metadata. `POST https://pump.fun/api/ipfs`, multipart: `file` (the image) + `name`,
 * `symbol`, `description`, `twitter`, `telegram`, `website`, `showName=true`.
 * Answers `{ metadata: {...}, metadataUri: "https://ipfs.io/ipfs/<cid>" }` (verified 2026-09-23).
 */
export async function uploadPumpMetadata(input: Omit<CreatePumpTokenInput, "creator" | "devBuySol" | "onSigned">): Promise<{ metadataUri: string; imageUri: string }> {
  const fd = new FormData();
  const ext = input.image.mime === "image/png" ? "png" : input.image.mime === "image/webp" ? "webp" : "jpg";
  fd.append("file", new Blob([new Uint8Array(input.image.bytes)], { type: input.image.mime }), `${input.symbol.toLowerCase()}.${ext}`);
  fd.append("name", input.name);
  fd.append("symbol", input.symbol);
  fd.append("description", input.description);
  if (input.twitter) fd.append("twitter", input.twitter);
  if (input.telegram) fd.append("telegram", input.telegram);
  if (input.website) fd.append("website", input.website);
  fd.append("showName", "true");
  const res = await fetch(PUMPFUN_IPFS, { method: "POST", body: fd, cache: "no-store" });
  if (!res.ok) throw new Error(`pump.fun metadata upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { metadataUri?: string; metadata?: { image?: string } };
  if (!json.metadataUri) throw new Error(`pump.fun metadata upload returned no metadataUri: ${JSON.stringify(json).slice(0, 300)}`);
  return { metadataUri: json.metadataUri, imageUri: json.metadata?.image ?? "" };
}

/**
 * Step 2 · create. `POST https://pumpportal.fun/api/trade-local` with
 * `{ publicKey: <creator>, action: "create", tokenMetadata: { name, symbol, uri }, mint: <new mint pubkey>,
 *    denominatedInSol: "true", amount: <devBuySol>, slippage: 10, priorityFee: 0.0005, pool: "pump" }`
 * → serialized VersionedTransaction with two required signers, [creator, mint] (verified 2026-09-23).
 * Re-stamped with our blockhash, signed with both keypairs, handed to `onSigned`, then sent and
 * confirmed here. Like `transferUsdc`, any failure after the send attempt carries `error.signature`
 * unless the RPC rejected it (`SendTransactionError`): the create may still land.
 */
export async function createPumpToken(input: CreatePumpTokenInput): Promise<CreatePumpTokenResult> {
  if (!(input.devBuySol >= 0)) throw new Error("devBuySol must be ≥ 0");
  const { metadataUri, imageUri } = await uploadPumpMetadata(input);
  const mint = Keypair.generate();
  const creator = input.creator.publicKey.toBase58();

  const res = await fetch(PUMPPORTAL_LOCAL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: creator,
      action: "create",
      tokenMetadata: { name: input.name, symbol: input.symbol, uri: metadataUri },
      mint: mint.publicKey.toBase58(),
      denominatedInSol: "true",
      amount: input.devBuySol,
      slippage: 10,
      priorityFee: CREATE_PRIORITY_FEE_SOL,
      pool: "pump",
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PumpPortal create ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  // Our own blockhash, so the expiry height is known exactly and recovery can tell "may still land" from "never will".
  const conn = rpc();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  tx.sign([mint, input.creator]);
  const signature = bs58.encode(tx.signatures[0]);
  await input.onSigned({ mint: mint.publicKey.toBase58(), signature, lastValidBlockHeight, metadataUri });

  let failedOnChain: unknown = null;
  try {
    await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
    failedOnChain = (await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
  } catch (e) {
    if (e instanceof SendTransactionError) throw e;
    throw Object.assign(e instanceof Error ? e : new Error(`pump.fun create ${signature}: ${JSON.stringify(e)}`), { signature });
  }
  if (failedOnChain) throw new Error(`pump.fun create ${signature} failed on-chain: ${JSON.stringify(failedOnChain)}`);
  return { mint: mint.publicKey.toBase58(), metadataUri, imageUri, signature };
}

/** SOL the creator key must hold before `createPumpToken`: dev buy + rent/fees reserve. */
export function pumpCreateBudgetSol(devBuySol: number): number {
  return Math.round((devBuySol + PUMP_CREATE_RESERVE_SOL) * 1e9) / 1e9;
}

/** Where a creator does the redirect. */
export function pumpfunCreatorRewardsUrl(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}
