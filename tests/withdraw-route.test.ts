import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type * as PriceModule from "@/lib/solana/price";
import type * as RpcModule from "@/lib/solana/rpc";

/** Stub chain: counts broadcasts; every read answers as a funded wallet. No network. */
const chain = vi.hoisted(() => ({ sent: 0 }));
vi.mock("@/lib/solana/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof RpcModule>();
  const blockhash = "11111111111111111111111111111111";
  const conn = {
    getBalance: async () => 10_000_000_000,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    sendRawTransaction: async () => `sig${++chain.sent}`,
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return { ...actual, rpc: () => conn };
});
vi.mock("@/lib/solana/price", async (importOriginal) => ({ ...(await importOriginal<typeof PriceModule>()), solPriceUsd: async () => 100 }));
/** In-memory stand-in for Next's request cookie jar. */
const jar = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return { get: (name: string) => (name in store ? { name, value: store[name] } : undefined), set: (name: string, value: string) => void (store[name] = value), delete: (name: string) => void delete store[name] };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar }));

import { POST } from "@/app/api/wallet/withdraw/route";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { createUserWallet } from "@/lib/wallet";

describe("POST /api/wallet/withdraw", () => {
  it("rate-limits new intents but answers a retry of a recorded one without spending the limit or sending again", async () => {
    const id = "usr_route";
    const walletAddress = await createUserWallet(id);
    await db.insert(users).values({ id, googleSub: "route", email: "route@test.local", walletAddress, createdAt: new Date(), lastLoginAt: new Date() });
    await createSession(id, new Request("http://localhost/"));
    const to = Keypair.generate().publicKey.toBase58();
    const send = async (idempotencyKey: string, amount = "0.001") => {
      const res = await POST(new Request("http://localhost/api/wallet/withdraw", { method: "POST", body: JSON.stringify({ mint: "SOL", amount, to, idempotencyKey }) }), { params: Promise.resolve({}) });
      return { status: res.status, body: await res.json() };
    };

    // `configured` is computed from the env at import; this file has no SOLANA_RPC_URL, so flip it for the stubbed chain.
    const flags: { rpc: boolean } = configured;
    flags.rpc = true;
    try {
      const first = await send("route-intent-0000000");
      expect(first.status).toBe(201);
      for (let i = 1; i < 5; i++) expect((await send(`route-intent-000000${i}`)).status).toBe(201);
      expect(chain.sent).toBe(5);

      const sixth = await send("route-intent-0000005");
      expect(sixth.status).toBe(429);
      expect(chain.sent).toBe(5);

      const retry = await send("route-intent-0000000");
      expect(retry.status).toBe(201);
      expect(retry.body.data.id).toBe(first.body.data.id);
      expect(retry.body.data.txSig).toBe(first.body.data.txSig);
      // A known key carrying a different transfer is still refused as a conflict, not sent.
      expect((await send("route-intent-0000000", "0.002")).status).toBe(409);
      expect(chain.sent).toBe(5);
    } finally {
      flags.rpc = false;
    }
  });
});
