import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { users, walletTransfers, type WalletTransfer } from "@/lib/db/schema";
import { configured, env } from "@/lib/env";
import { generateKey, loadKeypair } from "@/lib/keys";
import { priceUsd, solPriceUsd } from "@/lib/solana/price";
import { rpc, SOL_MINT, USDC_MINT } from "@/lib/solana/rpc";
import { sendOutcome, type SendOutcome } from "@/lib/solana/transfer";

/**
 * Custodial Solana wallet per user. The secret lives in `keys` (purpose `user_wallet`) under KMS;
 * the server signs on the user's behalf. Every outflow is a `walletTransfers` row.
 */

export const RPC_NOT_CONFIGURED = "RPC not configured";
/** Lamports that must remain after any withdrawal: covers rent-exemption of the system account plus a few fees. */
export const MIN_SOL_RESERVE_LAMPORTS = BigInt(2_000_000);
/** Base fee for a single-signer transaction. */
const TX_FEE_LAMPORTS = BigInt(5_000);
/** Rent-exempt minimum for a 165-byte token account (recipient ATA created by the sender). */
const ATA_RENT_LAMPORTS = BigInt(2_039_280);

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 402 | 404 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Mint a custodial wallet for `userId`. Throws `KmsNotConfiguredError` when FEE_ROUTER_KMS_KEY is unset. */
export async function createUserWallet(userId: string): Promise<string> {
  return (await generateKey("user_wallet", userId)).address;
}

export interface TokenBalance {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

export interface WalletBalances {
  sol: number;
  usdc: number;
  /** Every non-zero SPL balance (Token and Token-2022), USDC included. */
  tokens: TokenBalance[];
}

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } } };
}

/** SOL + every SPL balance of `address`. Requires SOLANA_RPC_URL (the public endpoint throttles account scans). */
export async function walletBalances(address: string): Promise<WalletBalances> {
  if (!configured.rpc) throw new WalletError(RPC_NOT_CONFIGURED, 503);
  const owner = new PublicKey(address);
  const conn = rpc();
  const [lamports, legacy, t22] = await Promise.all([conn.getBalance(owner, "confirmed"), conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"), conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed")]);
  const byMint = new Map<string, TokenBalance>();
  for (const { account } of [...legacy.value, ...t22.value] as ParsedTokenAccount[]) {
    const info = account.data.parsed.info;
    const raw = BigInt(info.tokenAmount.amount);
    if (raw === BigInt(0)) continue;
    const prev = byMint.get(info.mint);
    const amountRaw = (prev ? BigInt(prev.amountRaw) : BigInt(0)) + raw;
    byMint.set(info.mint, { mint: info.mint, amountRaw: amountRaw.toString(), decimals: info.tokenAmount.decimals, uiAmount: Number(amountRaw) / 10 ** info.tokenAmount.decimals });
  }
  const tokens = [...byMint.values()].sort((a, b) => b.uiAmount - a.uiAmount);
  return { sol: lamports / LAMPORTS_PER_SOL, usdc: byMint.get(USDC_MINT.toBase58())?.uiAmount ?? 0, tokens };
}

export interface WithdrawInput {
  /** `"SOL"` for native SOL, otherwise an SPL mint address. */
  mint: "SOL" | string;
  /** Integer in the asset's base units. */
  amountRaw: string;
  to: string;
  /** Client-generated per withdraw intent. A repeat returns the transfer already recorded under it instead of sending again. */
  idempotencyKey: string;
}

interface Asset {
  decimals: number;
  priceMint: string;
  programId: PublicKey | null;
}

async function resolveAsset(mint: string): Promise<Asset> {
  if (mint === "SOL") return { decimals: 9, priceMint: SOL_MINT, programId: null };
  let pk: PublicKey;
  try {
    pk = new PublicKey(mint);
  } catch {
    throw new WalletError("Invalid mint address");
  }
  const info = await rpc().getAccountInfo(pk, "confirmed");
  if (!info) throw new WalletError("Mint account not found", 404);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null;
  if (!programId) throw new WalletError("Address is not an SPL mint");
  const m = await getMint(rpc(), pk, "confirmed", programId);
  return { decimals: m.decimals, priceMint: mint, programId };
}

/** Decimals of an asset accepted by `withdraw`, for turning UI amounts into base units. */
export async function assetDecimals(mint: string): Promise<number> {
  if (mint === "SOL") return 9;
  if (mint === USDC_MINT.toBase58()) return 6;
  if (!configured.rpc) throw new WalletError(RPC_NOT_CONFIGURED, 503);
  return (await resolveAsset(mint)).decimals;
}

/** "1.25" with 6 decimals → 1250000n. Rejects more fractional digits than the asset carries. */
export function uiToRaw(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new WalletError("Amount must be a positive decimal number");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new WalletError(`Amount has more than ${decimals} decimal places`);
  const raw = BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (raw <= BigInt(0)) throw new WalletError("Amount must be positive");
  return raw;
}

async function assertUnderCap(asset: Asset, amountRaw: bigint): Promise<void> {
  const cap = env.WALLET_WITHDRAW_MAX_USD;
  let price: number;
  try {
    price = asset.priceMint === SOL_MINT ? await solPriceUsd() : await priceUsd(asset.priceMint);
  } catch (e) {
    throw new WalletError(`Could not price ${asset.priceMint === SOL_MINT ? "SOL" : asset.priceMint} to enforce the withdrawal cap: ${e instanceof Error ? e.message : String(e)}`, 503);
  }
  const usd = (Number(amountRaw) / 10 ** asset.decimals) * price;
  if (usd > cap) throw new WalletError(`Withdrawal of about $${usd.toFixed(2)} exceeds the per-transaction cap of $${cap.toLocaleString("en-US")}`);
}

interface Built {
  tx: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

async function buildTransfer(kp: Keypair, asset: Asset, mint: string, amountRaw: bigint, dest: PublicKey): Promise<Built> {
  const conn = rpc();
  const from = kp.publicKey;
  const lamports = BigInt(await conn.getBalance(from, "confirmed"));
  const tx = new Transaction();
  let cost = TX_FEE_LAMPORTS;

  if (asset.programId === null) {
    cost += amountRaw;
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: amountRaw }));
  } else {
    const mintPk = new PublicKey(mint);
    const fromAta = getAssociatedTokenAddressSync(mintPk, from, false, asset.programId);
    const toAta = getAssociatedTokenAddressSync(mintPk, dest, true, asset.programId);
    let held = BigInt(0);
    try {
      held = (await getAccount(conn, fromAta, "confirmed", asset.programId)).amount;
    } catch (e) {
      if (!(e instanceof TokenAccountNotFoundError)) throw e;
    }
    if (held < amountRaw) throw new WalletError(`Insufficient balance: holding ${held} base units, sending ${amountRaw}`, 402);
    if (!(await conn.getAccountInfo(toAta, "confirmed"))) {
      cost += ATA_RENT_LAMPORTS;
      tx.add(createAssociatedTokenAccountIdempotentInstruction(from, toAta, dest, mintPk, asset.programId));
    }
    tx.add(createTransferCheckedInstruction(fromAta, mintPk, toAta, from, amountRaw, asset.decimals, [], asset.programId));
  }

  if (lamports < cost + MIN_SOL_RESERVE_LAMPORTS) {
    const need = Number(cost + MIN_SOL_RESERVE_LAMPORTS) / LAMPORTS_PER_SOL;
    throw new WalletError(`Insufficient SOL: this transfer needs ${need.toFixed(6)} SOL (amount, fees and a ${Number(MIN_SOL_RESERVE_LAMPORTS) / LAMPORTS_PER_SOL} SOL reserve), wallet holds ${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)}`, 402);
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;
  tx.sign(kp);
  return { tx, blockhash, lastValidBlockHeight };
}

/**
 * Send `amountRaw` of `mint` from the user's custodial wallet to `to`.
 * Preconditions (RPC/KMS configured, valid recipient, cap, balances) are checked BEFORE a
 * `walletTransfers` row exists: a refused withdrawal leaves no ledger trace. Once the row is
 * inserted it moves pending → sent → confirmed, or → failed with the error. The row turns `sent`
 * with the signature and its expiry before the broadcast; a transaction that was sent but could not
 * be confirmed (expired wait, RPC error, crash) may still land, so it stays `sent` with the error
 * until `settleSentWithdrawals` reads the outcome from the chain: `failed` would invite the user to
 * send it again.
 * Idempotent on (userId, idempotencyKey): a retry whose response was lost gets the recorded row
 * back (whatever its status) and nothing is sent; reusing a key for a different transfer is a 409.
 */
export async function withdraw(userId: string, input: WithdrawInput): Promise<WalletTransfer> {
  if (!configured.rpc) throw new WalletError(RPC_NOT_CONFIGURED, 503);
  if (!configured.kms) throw new WalletError("KMS not configured", 503);
  let dest: PublicKey;
  try {
    dest = new PublicKey(input.to);
  } catch {
    throw new WalletError("Invalid recipient address");
  }
  let amountRaw: bigint;
  try {
    amountRaw = BigInt(input.amountRaw);
  } catch {
    throw new WalletError("amountRaw must be an integer");
  }
  if (amountRaw <= BigInt(0)) throw new WalletError("Amount must be positive");
  const assetMint = input.mint === "SOL" ? SOL_MINT : input.mint;

  const recorded = async (): Promise<WalletTransfer | null> => {
    const prior = await findWithdrawal(userId, input.idempotencyKey);
    if (!prior) return null;
    if (prior.assetMint !== assetMint || prior.amountRaw !== amountRaw.toString() || prior.toAddress !== dest.toBase58()) throw new WalletError("This idempotency key was already used for a different transfer", 409);
    return prior;
  };
  const replay = await recorded();
  if (replay) return replay;

  const user = await db.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, userId)).get();
  if (!user) throw new WalletError("User not found", 404);
  if (dest.toBase58() === user.walletAddress) throw new WalletError("Recipient is this wallet");

  const asset = await resolveAsset(input.mint);
  await assertUnderCap(asset, amountRaw);
  const kp = await loadKeypair(user.walletAddress);
  const built = await buildTransfer(kp, asset, input.mint, amountRaw, dest);

  const id = `wtx_${nanoid(12)}`;
  try {
    await db.insert(walletTransfers).values({ id, userId, kind: "withdraw", assetMint, amountRaw: amountRaw.toString(), toAddress: dest.toBase58(), status: "pending", idempotencyKey: input.idempotencyKey, createdAt: new Date() });
  } catch (e) {
    // A concurrent request with the same key won the unique index: it sends, this one reports its row.
    const raced = await recorded();
    if (raced) return raced;
    throw e;
  }

  const conn = rpc();
  const sig = bs58.encode(built.tx.signature!);
  let broadcast = false;
  try {
    await db.update(walletTransfers).set({ status: "sent", txSig: sig, lastValidBlockHeight: built.lastValidBlockHeight }).where(eq(walletTransfers.id, id));
    broadcast = true;
    await conn.sendRawTransaction(built.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
    await db
      .update(walletTransfers)
      .set(conf.value.err ? { status: "failed", error: `Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}` } : { status: "confirmed" })
      .where(eq(walletTransfers.id, id));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Not broadcast, or refused by the RPC (preflight): nothing can land. Anything else may still land.
    await db.update(walletTransfers).set(broadcast && !(e instanceof SendTransactionError) ? { status: "sent", error } : { status: "failed", error }).where(eq(walletTransfers.id, id));
  }
  return (await db.select().from(walletTransfers).where(eq(walletTransfers.id, id)).get())!;
}

export interface WithdrawalSettlement {
  id: string;
  outcome: SendOutcome["state"];
}

/**
 * Settle `sent` withdrawals from the chain: landed → `confirmed`; failed on-chain, or expired
 * without a trace (its blockhash is dead, it can never land) → `failed`. Anything else, including
 * a row sent before expiries were recorded whose signature is not found, stays `sent`.
 * Idempotent: every write is conditional on the row still being `sent`.
 */
export async function settleSentWithdrawals(limit = 50): Promise<WithdrawalSettlement[]> {
  const sent = await db
    .select()
    .from(walletTransfers)
    .where(and(eq(walletTransfers.kind, "withdraw"), eq(walletTransfers.status, "sent"), isNotNull(walletTransfers.txSig)))
    .limit(limit);
  const out: WithdrawalSettlement[] = [];
  for (const t of sent) {
    const sig = t.txSig!;
    const o = await sendOutcome(sig, t.lastValidBlockHeight);
    const set =
      o.state === "landed"
        ? { status: "confirmed" as const, error: null }
        : o.state === "failed"
          ? { status: "failed" as const, error: `Transaction ${sig} failed: ${JSON.stringify(o.err)}` }
          : o.state === "expired"
            ? { status: "failed" as const, error: `Transaction ${sig} expired unconfirmed: the chain passed block ${t.lastValidBlockHeight} without it, so it never landed and nothing was sent.` }
            : null;
    if (set) await db.update(walletTransfers).set(set).where(and(eq(walletTransfers.id, t.id), eq(walletTransfers.status, "sent")));
    out.push({ id: t.id, outcome: o.state });
  }
  return out;
}

/** The withdrawal recorded under (userId, idempotencyKey), whatever its status. Pure DB read. */
export async function findWithdrawal(userId: string, idempotencyKey: string): Promise<WalletTransfer | null> {
  return (await db.select().from(walletTransfers).where(and(eq(walletTransfers.userId, userId), eq(walletTransfers.idempotencyKey, idempotencyKey))).get()) ?? null;
}

export function recentTransfers(userId: string, limit = 20): Promise<WalletTransfer[]> {
  return db.select().from(walletTransfers).where(eq(walletTransfers.userId, userId)).orderBy(desc(walletTransfers.createdAt)).limit(limit);
}
