import { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { configured } from "@/lib/env";
import { ensureAnchorSigner, loadKeypair } from "@/lib/keys";
import { MEMO_PROGRAM_ID, rpc } from "./rpc";

/**
 * Anchor `text` on-chain as a Memo-program instruction signed by the anchor_signer key.
 * Returns the signature, or null (with a log line) when anchoring is not configured.
 * The signer must hold a little SOL for fees; that is an ops concern surfaced in the log.
 */
export async function anchorMemo(text: string): Promise<string | null> {
  if (!configured.anchor) {
    console.warn(`[anchor] not configured (needs FEE_ROUTER_KMS_KEY + SOLANA_RPC_URL); memo not anchored: ${text}`);
    return null;
  }
  const signer = await loadKeypair(await ensureAnchorSigner());
  const ix = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") });
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(rpc(), tx, [signer], { commitment: "confirmed" });
}

/** Below this the signer cannot pay for memo transactions much longer; /admin asks for a top-up. */
export const ANCHOR_SIGNER_MIN_SOL = 0.05;

export interface AnchorSignerStatus {
  /** Null until KMS is configured (the signer is minted on first use). */
  address: string | null;
  /** Null when no RPC balance could be read. */
  solBalance: number | null;
  low: boolean;
}

/** Anchor signer address and SOL balance for the operator dashboard. Never throws. */
export async function anchorSignerStatus(): Promise<AnchorSignerStatus> {
  if (!configured.kms) return { address: null, solBalance: null, low: false };
  const address = await ensureAnchorSigner();
  try {
    const solBalance = (await rpc().getBalance(new PublicKey(address), "confirmed")) / 1e9;
    return { address, solBalance, low: solBalance < ANCHOR_SIGNER_MIN_SOL };
  } catch (e) {
    console.warn(`[anchor] balance lookup failed for ${address}: ${e instanceof Error ? e.message : e}`);
    return { address, solBalance: null, low: false };
  }
}

/** Read every memo instruction's text out of a confirmed transaction. */
export async function readMemos(sig: string): Promise<string[]> {
  const tx = await rpc().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return [];
  const out: string[] = [];
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? [])];
  for (const ix of ixs) {
    if (!ix.programId.equals(MEMO_PROGRAM_ID)) continue;
    if ("parsed" in ix) out.push(String(ix.parsed));
    else if ("data" in ix) out.push(Buffer.from(ix.data, "base64").toString("utf8"));
  }
  return out;
}
