import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync, TokenAccountNotFoundError } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { USDC_DECIMALS, USDC_MINT, fromUsdcRaw, rpc, toUsdcRaw } from "./rpc";

/** Records a transfer's signature (and the last block height it can land at) before it is broadcast; throwing aborts the broadcast. */
export type OnSigned = (signature: string, lastValidBlockHeight: number) => Promise<void>;

/**
 * Sign `ixs` with `from` as fee payer, broadcast and confirm. The signature is known before anything
 * is broadcast: `onSigned` records it first. Every failure after that point (RPC dropped the send,
 * confirmation expired) carries it as `error.signature`, because the transaction may still land.
 * Only an RPC rejection (`SendTransactionError`, preflight) or an on-chain failure means nothing moved.
 */
async function signAndSend(from: Keypair, ixs: TransactionInstruction[], what: string, onSigned?: OnSigned): Promise<string> {
  const conn = rpc();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: from.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(from);
  const signature = bs58.encode(tx.signature!);
  await onSigned?.(signature, lastValidBlockHeight);
  let failedOnChain: unknown = null;
  try {
    await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    failedOnChain = (await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
  } catch (e) {
    if (e instanceof SendTransactionError) throw e;
    throw Object.assign(e instanceof Error ? e : new Error(`${what} ${signature}: ${JSON.stringify(e)}`), { signature });
  }
  if (failedOnChain) throw new Error(`${what} ${signature} failed on-chain: ${JSON.stringify(failedOnChain)}`);
  return signature;
}

/** Transfer `amountUsdc` from `from` to `to`, creating the destination ATA when missing. Failure contract: `signAndSend`. */
export async function transferUsdc(from: Keypair, to: string | PublicKey, amountUsdc: number, onSigned?: OnSigned): Promise<string> {
  const raw = toUsdcRaw(amountUsdc);
  if (raw <= BigInt(0)) throw new Error("transferUsdc: amount must be positive");
  const dest = typeof to === "string" ? new PublicKey(to) : to;
  const fromAta = getAssociatedTokenAddressSync(USDC_MINT, from.publicKey);
  const toAta = getAssociatedTokenAddressSync(USDC_MINT, dest, true);
  return signAndSend(
    from,
    [createAssociatedTokenAccountIdempotentInstruction(from.publicKey, toAta, dest, USDC_MINT), createTransferCheckedInstruction(fromAta, USDC_MINT, toAta, from.publicKey, raw, USDC_DECIMALS)],
    "USDC transfer",
    onSigned,
  );
}

export type SendOutcome = { state: "landed" } | { state: "failed"; err: unknown } | { state: "expired" } | { state: "unknown" };

/**
 * Where a broadcast transaction whose confirmation was never observed stands. `expired` only when
 * the finalized chain is past `lastValidBlockHeight` and the signature is nowhere in history: its
 * blockhash is dead, so it can never land. The height is read first: every block it could have
 * landed in is final by then, so the history lookup that follows cannot miss it. Without a
 * `lastValidBlockHeight` (rows sent before it was recorded) an unseen signature stays `unknown`.
 */
export async function sendOutcome(signature: string, lastValidBlockHeight: number | null): Promise<SendOutcome> {
  const conn = rpc();
  const past = lastValidBlockHeight !== null && (await conn.getBlockHeight("finalized")) > lastValidBlockHeight;
  const status = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) return { state: "failed", err: status.err };
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { state: "landed" };
  return !status && past ? { state: "expired" } : { state: "unknown" };
}

/** Plain SOL transfer of exactly `lamports`. Failure contract: `signAndSend`. */
export async function transferLamports(from: Keypair, to: string | PublicKey, lamports: bigint, onSigned?: OnSigned): Promise<string> {
  if (lamports <= BigInt(0)) throw new Error("transferLamports: amount must be positive");
  const dest = typeof to === "string" ? new PublicKey(to) : to;
  return signAndSend(from, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: dest, lamports })], "SOL transfer", onSigned);
}

/** Plain SOL transfer; used to fund a custodial creator key before a launch. */
export async function transferSol(from: Keypair, to: string | PublicKey, amountSol: number, onSigned?: OnSigned): Promise<string> {
  return transferLamports(from, to, BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)), onSigned);
}

export async function usdcBalance(owner: string | PublicKey): Promise<number> {
  const pk = typeof owner === "string" ? new PublicKey(owner) : owner;
  const ata = getAssociatedTokenAddressSync(USDC_MINT, pk, true);
  try {
    const acct = await getAccount(rpc(), ata, "confirmed");
    return fromUsdcRaw(acct.amount);
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0;
    throw e;
  }
}

export async function solBalance(owner: string | PublicKey): Promise<number> {
  const pk = typeof owner === "string" ? new PublicKey(owner) : owner;
  return (await rpc().getBalance(pk, "confirmed")) / 1e9;
}
