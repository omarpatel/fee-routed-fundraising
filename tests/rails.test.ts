import { Connection, Keypair, SendTransactionError, Transaction, type SignatureStatus } from "@solana/web3.js";
import bs58 from "bs58";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { causes, deliveries, deliveryAllocations, feeEvents, tokens, vaults } from "@/lib/db/schema";
import { generateKey } from "@/lib/keys";
import { deliverable } from "@/lib/ledger";
import { onchain, settleUnconfirmedFunding, unconfirmedFunding } from "@/lib/rails";
import { rpc } from "@/lib/solana/rpc";
import { rows } from "./fixtures";

// Rails refuse to move money without a write-capable RPC. This one is never dialled: every call the
// rail makes goes to the stubs on the process-wide Connection installed by `stubRpc`.
vi.hoisted(() => {
  process.env.SOLANA_RPC_URL = "http://127.0.0.1:9";
});

/** Installs the process-wide Connection; `send` answers sendRawTransaction. Returns every raw tx sent. */
function stubRpc(send: (raw: Buffer) => Promise<string>): Buffer[] {
  const conn = new Connection("http://127.0.0.1:9");
  const sent: Buffer[] = [];
  vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 });
  vi.spyOn(conn, "sendRawTransaction").mockImplementation(async (raw) => {
    sent.push(Buffer.from(raw as Uint8Array));
    return send(Buffer.from(raw as Uint8Array));
  });
  vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
  // Treasury balance lookups: unavailable, so `deliverable` reports the ledger view alone.
  vi.spyOn(conn, "getAccountInfo").mockRejectedValue(new Error("rpc down"));
  (globalThis as unknown as { __feeRouterRpc?: Connection }).__feeRouterRpc = conn;
  return sent;
}

/** What the chain says later about a signature: its status (null = never seen) at a finalized block height. */
function stubChain(status: SignatureStatus | null, blockHeight: number) {
  const conn = rpc();
  vi.spyOn(conn, "getSignatureStatuses").mockResolvedValue({ context: { slot: 1 }, value: [status] });
  vi.spyOn(conn, "getBlockHeight").mockResolvedValue(blockHeight);
}

const signatureOf = (raw: Buffer) => bs58.encode(Transaction.from(raw).signature!);

async function queuedOnchainDelivery(id: string) {
  const { address: treasury } = await generateKey("vault_treasury", id);
  await db.insert(causes).values(rows.cause(`cse_${id}`, { platform: "onchain", onchainAddress: Keypair.generate().publicKey.toBase58(), verificationStatus: "verified" }));
  await db.insert(vaults).values(rows.vault(id, `cse_${id}`, { treasuryAddress: treasury }));
  await db.insert(tokens).values(rows.token(`${id}_t`, id));
  await db.insert(feeEvents).values(rows.fee(`${id}_f`, id, `${id}_t`, 50, new Date()));
  await db.insert(deliveries).values({ id: `dlv_${id}`, ordinal: 1, vaultId: id, causeId: `cse_${id}`, rail: "onchain", status: "queued", amountUsdc: 50, queuedAt: new Date() });
  await db.insert(deliveryAllocations).values({ deliveryId: `dlv_${id}`, tokenId: `${id}_t`, amountUsdc: 50 });
  return (await db.select().from(deliveries).where(eq(deliveries.id, `dlv_${id}`)).get())!;
}

const rowOf = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)).get())!;

describe("onchain rail funding", () => {
  it("keeps the delivery funding with its signature when the RPC drops the send, so it is never failed and paid again", async () => {
    const d = await queuedOnchainDelivery("r1");
    const sent = stubRpc(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(onchain.fund(d)).rejects.toThrow(/fetch failed/);
    const row = await rowOf(d.id);
    expect(row.status).toBe("funding");
    expect(row.fundingTxSig).toBe(signatureOf(sent[0]));
  });

  it("keeps a landed transfer on the row when recording it fails", async () => {
    const d = await queuedOnchainDelivery("r2");
    const sent = stubRpc(async (raw) => signatureOf(raw));
    // The write that marks the row funded fails (disk, lock); the USDC has already moved.
    await db.run(sql`create trigger r2_funded_write_fails before update of status on deliveries when new.status = 'funded' begin select raise(abort, 'database is locked'); end`);
    try {
      await expect(onchain.fund(d)).rejects.toThrow(/was sent but recording it failed/);
    } finally {
      await db.run(sql`drop trigger r2_funded_write_fails`);
    }
    const row = await rowOf(d.id);
    expect(row.status).toBe("funding");
    expect(row.fundingTxSig).toBe(signatureOf(sent[0]));
  });

  it("fails the delivery when the RPC rejects the transfer before broadcasting it", async () => {
    const d = await queuedOnchainDelivery("r3");
    stubRpc(async () => {
      throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "insufficient funds" });
    });
    await expect(onchain.fund(d)).rejects.toBeInstanceOf(SendTransactionError);
    const row = await rowOf(d.id);
    expect(row.status).toBe("failed");
    expect(row.fundingTxSig).toBeNull();
  });
});

describe("settling an unconfirmed funding transfer", () => {
  /** An onchain delivery whose send was dropped by the RPC: `funding`, signature and expiry (block 1000) recorded. */
  async function unconfirmed(id: string) {
    const d = await queuedOnchainDelivery(id);
    const sent = stubRpc(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(onchain.fund(d)).rejects.toThrow(/fetch failed/);
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "funding", fundingTxSig: signatureOf(sent[0]), fundingLastValidBlockHeight: 1_000 });
    return row;
  }

  it("fails a transfer that expired without a trace, dropping the signature, so the vault can queue again", async () => {
    const d = await unconfirmed("s1");
    expect((await unconfirmedFunding()).map((x) => x.id)).toContain(d.id);

    // Still inside its validity window: it could land, so nothing is decided.
    stubChain(null, 1_000);
    expect((await settleUnconfirmedFunding(d.id)).outcome).toBe("waiting");
    expect((await rowOf(d.id)).status).toBe("funding");
    expect((await deliverable("s1")).inFlight).toBe(1);

    stubChain(null, 1_001);
    expect((await settleUnconfirmedFunding(d.id)).outcome).toBe("failed");
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "failed", fundingTxSig: null, fundingLastValidBlockHeight: null });
    expect(row.failureReason).toMatch(new RegExp(`${d.fundingTxSig}.*never landed`));
    // Nothing left the treasury: the amount is released and nothing blocks autoQueue.
    expect(await deliverable("s1")).toMatchObject({ inFlight: 0, ledgerUsd: 50 });
    expect(await settleUnconfirmedFunding(d.id)).toMatchObject({ outcome: "waiting" });
  });

  it("advances a transfer found confirmed on-chain exactly like a confirmed send", async () => {
    const d = await unconfirmed("s2");
    // Past its window, but it did land: the history lookup wins over the expiry.
    stubChain({ slot: 5, confirmations: null, err: null, confirmationStatus: "finalized" }, 2_000);
    expect((await settleUnconfirmedFunding(d.id)).outcome).toBe("landed");
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "funded", fundingTxSig: d.fundingTxSig, fundingLastValidBlockHeight: null });
    expect(row.fundedAt).not.toBeNull();
    expect((await unconfirmedFunding()).map((x) => x.id)).not.toContain(d.id);
  });

  it("fails a transfer that landed but failed on-chain, and leaves a legacy row without an expiry alone until it is found", async () => {
    const d = await unconfirmed("s3");
    await db.update(deliveries).set({ fundingLastValidBlockHeight: null }).where(eq(deliveries.id, d.id));
    stubChain(null, 5_000);
    expect((await settleUnconfirmedFunding(d.id)).outcome).toBe("waiting");
    expect((await rowOf(d.id)).status).toBe("funding");

    stubChain({ slot: 5, confirmations: 10, err: { InstructionError: [1, { Custom: 1 }] }, confirmationStatus: "confirmed" }, 5_000);
    expect((await settleUnconfirmedFunding(d.id)).outcome).toBe("failed");
    expect(await rowOf(d.id)).toMatchObject({ status: "failed", fundingTxSig: null });
  });
});
