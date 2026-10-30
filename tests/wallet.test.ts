import { Keypair, type SignatureStatus } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type * as PriceModule from "@/lib/solana/price";
import type * as RpcModule from "@/lib/solana/rpc";

/** Stub chain: counts broadcasts; every read answers as a funded wallet; `landed`/`height` are what a later lookup finds. No network. */
const chain = vi.hoisted(() => ({ sent: 0, landed: {} as Record<string, SignatureStatus>, height: 0 }));
vi.mock("@/lib/solana/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof RpcModule>();
  // vi.mock factories run before the file's static imports are bound, so their modules load here.
  const { Transaction } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;
  const blockhash = "11111111111111111111111111111111";
  const conn = {
    getBalance: async () => 10_000_000_000,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw: Buffer) => {
      chain.sent++;
      return bs58.encode(Transaction.from(raw).signature!);
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => chain.landed[s] ?? null) }),
    getBlockHeight: async () => chain.height,
  };
  return { ...actual, rpc: () => conn };
});
vi.mock("@/lib/solana/price", async (importOriginal) => ({ ...(await importOriginal<typeof PriceModule>()), solPriceUsd: async () => 100 }));

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, walletTransfers } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { rpc } from "@/lib/solana/rpc";
import { assetDecimals, createUserWallet, RPC_NOT_CONFIGURED, settleSentWithdrawals, uiToRaw, WalletError, withdraw } from "@/lib/wallet";

describe("uiToRaw", () => {
  it("converts decimal strings exactly, without floating point", () => {
    expect(uiToRaw("1.5", 9)).toBe(BigInt(1_500_000_000));
    expect(uiToRaw("0.000000001", 9)).toBe(BigInt(1));
    expect(uiToRaw("1.25", 6)).toBe(BigInt(1_250_000));
    expect(uiToRaw("  7 ", 6)).toBe(BigInt(7_000_000));
    expect(uiToRaw("123456789.123456789", 9)).toBe(BigInt("123456789123456789"));
    expect(uiToRaw("1", 0)).toBe(BigInt(1));
  });

  it("rejects excess precision, zero, negatives, and non-numbers", () => {
    expect(() => uiToRaw("1.0000000001", 9)).toThrow(/decimal places/);
    expect(() => uiToRaw("0.1", 0)).toThrow(/decimal places/);
    expect(() => uiToRaw("0", 9)).toThrow(/positive/);
    expect(() => uiToRaw("0.0", 9)).toThrow(/positive/);
    for (const bad of ["-1", "1e9", ".5", "1.", "abc", "", "1,5", "0x10"]) expect(() => uiToRaw(bad, 9), bad).toThrow(WalletError);
  });
});

describe("withdraw without RPC", () => {
  it("refuses with 503 before touching the ledger", async () => {
    const id = "usr_w";
    const walletAddress = await createUserWallet(id);
    await db.insert(users).values({ id, googleSub: "w", email: "w@test.local", walletAddress, createdAt: new Date(), lastLoginAt: new Date() });

    const err = await withdraw(id, { mint: "SOL", amountRaw: "1000", to: Keypair.generate().publicKey.toBase58(), idempotencyKey: "intent-norpc-000000" }).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect(err.status).toBe(503);
    expect(err.message).toBe(RPC_NOT_CONFIGURED);
    expect(await db.select().from(walletTransfers)).toEqual([]);
  });

  it("knows SOL and USDC decimals offline and needs RPC for anything else", async () => {
    expect(await assetDecimals("SOL")).toBe(9);
    expect(await assetDecimals("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(6);
    await expect(assetDecimals(Keypair.generate().publicKey.toBase58())).rejects.toMatchObject({ status: 503 });
  });
});

describe("withdraw idempotency", () => {
  it("sends once per key: retries and concurrent duplicates get the recorded transfer, a different transfer under the key is refused", async () => {
    const id = "usr_idem";
    const walletAddress = await createUserWallet(id);
    await db.insert(users).values({ id, googleSub: "idem", email: "idem@test.local", walletAddress, createdAt: new Date(), lastLoginAt: new Date() });
    const to = Keypair.generate().publicKey.toBase58();
    const intent = (idempotencyKey: string, amountRaw = "1000000") => ({ mint: "SOL", amountRaw, to, idempotencyKey });

    // `configured` is a plain object computed from the env at import; this file has no SOLANA_RPC_URL, so flip it for the stubbed chain.
    const flags: { rpc: boolean } = configured;
    flags.rpc = true;
    try {
      const first = await withdraw(id, intent("intent-one-000000000"));
      expect(first).toMatchObject({ status: "confirmed", lastValidBlockHeight: 100 });
      const retry = await withdraw(id, intent("intent-one-000000000"));
      expect(retry.id).toBe(first.id);
      expect(chain.sent).toBe(1);

      const [a, b] = await Promise.all([withdraw(id, intent("intent-two-000000000")), withdraw(id, intent("intent-two-000000000"))]);
      expect(a.id).toBe(b.id);
      expect(chain.sent).toBe(2);

      await expect(withdraw(id, intent("intent-one-000000000", "2000000"))).rejects.toMatchObject({ status: 409 });
      expect(chain.sent).toBe(2);
      expect(await db.select().from(walletTransfers).where(and(eq(walletTransfers.userId, id), eq(walletTransfers.kind, "withdraw")))).toHaveLength(2);
    } finally {
      flags.rpc = false;
    }
  });

  it("keeps a sent withdrawal `sent` with the error when its confirmation cannot be observed, so the user is not told to send it again", async () => {
    const id = "usr_unconfirmed";
    const walletAddress = await createUserWallet(id);
    await db.insert(users).values({ id, googleSub: "unconfirmed", email: "unconfirmed@test.local", walletAddress, createdAt: new Date(), lastLoginAt: new Date() });
    vi.spyOn(rpc(), "confirmTransaction").mockRejectedValueOnce(new Error("block height exceeded"));
    const flags: { rpc: boolean } = configured;
    flags.rpc = true;
    try {
      const t = await withdraw(id, { mint: "SOL", amountRaw: "1000000", to: Keypair.generate().publicKey.toBase58(), idempotencyKey: "intent-unconfirmed-0" });
      expect(t.status).toBe("sent");
      expect(t.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      expect(t.error).toMatch(/block height exceeded/);
    } finally {
      flags.rpc = false;
    }
  });

  it("settles a sent withdrawal from the chain: unseen within its window stays sent, landed confirms, unseen past it fails", async () => {
    const id = "usr_settle";
    const walletAddress = await createUserWallet(id);
    await db.insert(users).values({ id, googleSub: "settle", email: "settle@test.local", walletAddress, createdAt: new Date(), lastLoginAt: new Date() });
    const flags: { rpc: boolean } = configured;
    flags.rpc = true;
    try {
      const send = async (idempotencyKey: string) => {
        vi.spyOn(rpc(), "confirmTransaction").mockRejectedValueOnce(new Error("block height exceeded"));
        return withdraw(id, { mint: "SOL", amountRaw: "1000000", to: Keypair.generate().publicKey.toBase58(), idempotencyKey });
      };
      const landed = await send("intent-settle-landed");
      const lost = await send("intent-settle-lost00");
      const statusOf = async (tid: string) => (await db.select().from(walletTransfers).where(eq(walletTransfers.id, tid)).get())!.status;

      chain.height = 100;
      await settleSentWithdrawals();
      expect([await statusOf(landed.id), await statusOf(lost.id)]).toEqual(["sent", "sent"]);

      chain.landed[landed.txSig!] = { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" };
      chain.height = 101;
      await settleSentWithdrawals();
      const row = (await db.select().from(walletTransfers).where(eq(walletTransfers.id, lost.id)).get())!;
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/never landed/);
      expect(await statusOf(landed.id)).toBe("confirmed");
    } finally {
      flags.rpc = false;
    }
  });
});
