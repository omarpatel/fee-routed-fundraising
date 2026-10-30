import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RpcModule from "@/lib/solana/rpc";

/** Stub chain: treasury history, transactions, balances, statuses and height are set per test; every broadcast transfer is recorded. No network. */
const chain = vi.hoisted(() => ({
  height: 1000,
  balances: new Map<string, number>(),
  statuses: new Map<string, { err: unknown; confirmationStatus: string }>(),
  /** Newest first, as getSignaturesForAddress answers. */
  history: new Map<string, string[]>(),
  failed: new Set<string>(),
  txs: new Map<string, unknown>(),
  fetched: [] as string[],
  sent: [] as { from: string; to: string; lamports: bigint; sig: string }[],
  /** "ok" confirms the transfer; "ambiguous" drops the connection after the send (it may have landed). */
  send: "ok" as "ok" | "ambiguous",
}));
vi.mock("@/lib/solana/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof RpcModule>();
  type Pk = { toBase58(): string };
  const conn = {
    getBalance: async (pk: Pk) => chain.balances.get(pk.toBase58()) ?? 0,
    getMinimumBalanceForRentExemption: async () => 890_880,
    getBlockHeight: async () => chain.height,
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => chain.statuses.get(s) ?? null) }),
    getSignaturesForAddress: async (pk: Pk, opts: { before?: string; limit?: number } = {}) => {
      const all = chain.history.get(pk.toBase58()) ?? [];
      const start = opts.before ? all.indexOf(opts.before) + 1 : 0;
      return all.slice(start, start + (opts.limit ?? 1000)).map((signature) => ({ signature, err: chain.failed.has(signature) ? { InstructionError: [0, "Custom"] } : null }));
    },
    getTransaction: async (sig: string) => {
      chain.fetched.push(sig);
      return chain.txs.get(sig) ?? null;
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: chain.height + 150 }),
    sendRawTransaction: async (raw: Buffer) => {
      // Dynamic: a vi.mock factory is hoisted above this file's static imports.
      const { SystemInstruction, Transaction } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;
      const tx = Transaction.from(raw);
      const t = SystemInstruction.decodeTransfer(tx.instructions[0]);
      const sig = bs58.encode(tx.signature!);
      chain.sent.push({ from: t.fromPubkey.toBase58(), to: t.toPubkey.toBase58(), lamports: BigInt(t.lamports), sig });
      return sig;
    },
    confirmTransaction: async () => {
      if (chain.send === "ambiguous") throw new Error("socket hang up");
      return { value: { err: null } };
    },
  };
  return { ...actual, rpc: () => conn };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { causes, launches, protocolForwards, tokens, users, vaults } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { generateKey } from "@/lib/keys";
import { protocolStats } from "@/lib/protocol";
import { setProtocolConfig } from "@/lib/protocol/config";
import { forwardCommonsShare, recordProtocolClaims } from "@/lib/protocol/forward";
import { PUMP_AMM_PROGRAM_ID, PUMPFUN_PROGRAM_ID, SOL_MINT } from "@/lib/solana/rpc";
import { rows } from "./fixtures";

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const RENT = 890_880;
const RESERVE = RENT + 5_000_000;
const route = Keypair.generate().publicKey.toBase58();
const admin = Keypair.generate().publicKey.toBase58();
let treasury = "";
const log = () => {};

/**
 * A confirmed transaction as getTransaction returns it. `accounts[i]` has SOL `pre[i]` → `post[i]`;
 * `outer` programs are top-level instructions, `inner` are CPIs; `wsol` is a wrapped SOL account.
 */
function fakeTx(o: { accounts: string[]; pre: number[]; post: number[]; outer: string[]; inner?: string[]; fee?: number; wsol?: { owner: string; pre: string | null; post: string } }) {
  const keys = [...o.accounts, ...o.outer, ...(o.inner ?? [])];
  const pad = (b: number[]) => [...b, ...Array(keys.length - b.length).fill(1)];
  const wsol = (amount: string) => [{ accountIndex: keys.length, mint: SOL_MINT, owner: o.wsol!.owner, uiTokenAmount: { amount } }];
  return {
    meta: {
      err: null,
      fee: o.fee ?? 5000,
      preBalances: pad(o.pre),
      postBalances: pad(o.post),
      innerInstructions: o.inner ? [{ index: 0, instructions: o.inner.map((p) => ({ programIdIndex: keys.indexOf(p) })) }] : [],
      preTokenBalances: o.wsol?.pre ? wsol(o.wsol.pre) : [],
      postTokenBalances: o.wsol ? wsol(o.wsol.post) : [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: { message: { staticAccountKeys: keys.map((k) => new PublicKey(k)), compiledInstructions: o.outer.map((p) => ({ programIdIndex: keys.indexOf(p) })) } },
  };
}

const forwardRows = () => db.select().from(protocolForwards).orderBy(protocolForwards.createdAt);
let n = 0;
async function pending(...lamports: number[]) {
  for (const l of lamports) {
    const now = new Date(Date.now() + ++n);
    await db.insert(protocolForwards).values({ id: `pfw_t${n}`, claimSig: `claim_t${n}`, claimedLamports: String(l * 2), forwardLamports: String(l), toAddress: route, status: "pending", createdAt: now, updatedAt: now });
  }
}

beforeAll(async () => {
  // `configured` is computed from the env at import; this file has no SOLANA_RPC_URL, so flip it for the stubbed chain.
  const flags: { rpc: boolean } = configured;
  flags.rpc = true;
  treasury = (await generateKey("protocol_treasury", "protocol")).address;
  await db.insert(users).values({ id: "usr_adm", googleSub: "adm", email: "admin@test.local", role: "admin", walletAddress: admin, createdAt: new Date(), lastLoginAt: new Date() });
  await db.insert(causes).values(rows.cause("cse_c"));
  await db.insert(vaults).values(rows.vault("vlt_c", "cse_c"));
  await db.insert(tokens).values(rows.token("tok_fee-router", "vlt_c", { routeAddress: route, creatorWallet: treasury }));
  await db.insert(launches).values({ id: "lch_v", userId: "usr_adm", vaultId: "vlt_c", launchpad: "pumpfun", status: "launched", meta: { name: "Fee Router", symbol: "ROUTE", imageUrl: "/x.png", routeBps: 5000, routeAddress: route, protocol: true, creator: treasury, createSig: "create" }, createdAt: new Date() });
  await setProtocolConfig("protocol_treasury_address", treasury);
  await setProtocolConfig("protocol_mint", "RouteMint1111111111111111111111111111111111");
  await setProtocolConfig("protocol_launch_id", "lch_v");
});

beforeEach(async () => {
  chain.height = 1000;
  chain.balances.clear();
  chain.statuses.clear();
  chain.history.clear();
  chain.failed.clear();
  chain.txs.clear();
  chain.fetched = [];
  chain.sent = [];
  chain.send = "ok";
  await db.delete(protocolForwards);
});

describe("recordProtocolClaims", () => {
  it("books the Commons half of each claim once; the create, dev buy and plain transfers are not claims", async () => {
    // Treasury pays the claim's fee: +30 SOL-cents gross is post − pre + fee.
    chain.txs.set("claim1", fakeTx({ accounts: [treasury], pre: [100_000_000], post: [129_995_000], outer: [PUMPFUN_PROGRAM_ID] }));
    // PumpSwap claim through a CPI, paid by someone else, landing as wrapped SOL: odd lamports round down.
    chain.txs.set("claim2", fakeTx({ accounts: [admin, treasury], pre: [50_000_000, 129_995_000], post: [49_995_000, 129_995_000], outer: [COMPUTE_BUDGET], inner: [PUMP_AMM_PROGRAM_ID], wsol: { owner: treasury, pre: null, post: "20000001" } }));
    chain.txs.set("devbuy", fakeTx({ accounts: [treasury], pre: [200_000_000], post: [100_000_000], outer: [PUMPFUN_PROGRAM_ID] }));
    chain.txs.set("topup", fakeTx({ accounts: [admin, treasury], pre: [1_000_000_000, 0], post: [799_995_000, 200_000_000], outer: [SYSTEM] }));
    // Older than the create: never reached. A pump program gain there would otherwise be booked.
    chain.txs.set("old", fakeTx({ accounts: [treasury], pre: [0], post: [70_000_000], outer: [PUMPFUN_PROGRAM_ID] }));
    chain.failed.add("claimFailed");
    chain.history.set(treasury, ["claim2", "claimFailed", "topup", "claim1", "devbuy", "create", "old", "fund"]);

    expect(await recordProtocolClaims()).toBe(2);
    const booked = await forwardRows();
    expect(booked.map((r) => [r.claimSig, r.claimedLamports, r.forwardLamports, r.toAddress, r.status])).toEqual([
      ["claim1", "30000000", "15000000", route, "pending"],
      ["claim2", "20000001", "10000000", route, "pending"],
    ]);
    expect(chain.fetched).not.toContain("create");
    expect(chain.fetched).not.toContain("old");
    expect(chain.fetched).not.toContain("claimFailed");

    // Re-run: stops at the newest booked claim, books nothing.
    chain.fetched = [];
    expect(await recordProtocolClaims()).toBe(0);
    expect(chain.fetched).toEqual([]);
    expect(await forwardRows()).toHaveLength(2);

    // A later claim (e.g. from pump.fun's UI) is found; nothing at or below claim2 is fetched again.
    chain.txs.set("claim3", fakeTx({ accounts: [treasury], pre: [100_000_000], post: [110_000_000], outer: [PUMPFUN_PROGRAM_ID], fee: 0 }));
    chain.history.set(treasury, ["claim3", "claim2", "claimFailed", "topup", "claim1", "devbuy", "create", "old", "fund"]);
    expect(await recordProtocolClaims()).toBe(1);
    expect(chain.fetched).toEqual(["claim3"]);
  });

  it("stops at a transaction the RPC cannot return yet, so a newer claim never skips it", async () => {
    chain.txs.set("claimB", fakeTx({ accounts: [treasury], pre: [0], post: [40_000_000], outer: [PUMPFUN_PROGRAM_ID], fee: 0 }));
    chain.history.set(treasury, ["claimB", "claimA", "create"]);
    expect(await recordProtocolClaims()).toBe(0);

    chain.txs.set("claimA", fakeTx({ accounts: [treasury], pre: [0], post: [20_000_000], outer: [PUMPFUN_PROGRAM_ID], fee: 0 }));
    expect(await recordProtocolClaims()).toBe(2);
    expect((await forwardRows()).map((r) => r.claimSig).sort()).toEqual(["claimA", "claimB"]);
  });
});

describe("forwardCommonsShare", () => {
  it("sends one transfer for every pending row and never again", async () => {
    await pending(15_000_000, 10_000_000);
    chain.balances.set(treasury, 1_000_000_000);

    await forwardCommonsShare(log);
    expect(chain.sent).toEqual([{ from: treasury, to: route, lamports: BigInt(25_000_000), sig: expect.any(String) }]);
    const after = await forwardRows();
    expect(after.map((r) => [r.status, r.txSig])).toEqual([
      ["confirmed", chain.sent[0].sig],
      ["confirmed", chain.sent[0].sig],
    ]);

    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(1);
    const stats = await protocolStats();
    expect([stats.commonsForwardedSol, stats.commonsOwedSol]).toEqual([0.025, 0]);
  });

  it("unknown outcome: no resend; expired: back to pending and sent again", async () => {
    await pending(12_000_000);
    chain.balances.set(treasury, 1_000_000_000);
    chain.send = "ambiguous";

    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(1);
    const first = chain.sent[0].sig;
    const [sent] = await forwardRows();
    expect([sent.status, sent.txSig, sent.lastValidBlockHeight]).toEqual(["sent", first, 1150]);

    // Not seen, blockhash still live: unknown. A new claim meanwhile must wait too.
    await pending(20_000_000);
    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(1);
    expect((await forwardRows()).map((r) => r.status)).toEqual(["sent", "pending"]);

    // Past its last valid height and nowhere on-chain: nothing moved; both rows go out in one new transfer.
    chain.height = 1151;
    chain.send = "ok";
    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1].lamports).toBe(BigInt(32_000_000));
    expect((await forwardRows()).map((r) => [r.status, r.txSig])).toEqual([
      ["confirmed", chain.sent[1].sig],
      ["confirmed", chain.sent[1].sig],
    ]);
  });

  it("a sent transfer that landed is confirmed, not resent", async () => {
    await pending(12_000_000);
    chain.balances.set(treasury, 1_000_000_000);
    chain.send = "ambiguous";
    await forwardCommonsShare(log);
    chain.statuses.set(chain.sent[0].sig, { err: null, confirmationStatus: "finalized" });
    chain.send = "ok";

    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(1);
    expect((await forwardRows()).map((r) => r.status)).toEqual(["confirmed"]);
  });

  it("sends nothing below 0.01 SOL", async () => {
    await pending(5_000_000, 4_999_999);
    chain.balances.set(treasury, 1_000_000_000);
    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(0);
    expect((await forwardRows()).map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("sends nothing when the treasury would drop below its rent + fee reserve", async () => {
    await pending(25_000_000);
    chain.balances.set(treasury, 25_000_000 + RESERVE - 1);
    await forwardCommonsShare(log);
    expect(chain.sent).toHaveLength(0);
    expect((await forwardRows())[0].status).toBe("pending");

    chain.balances.set(treasury, 25_000_000 + RESERVE);
    await forwardCommonsShare(log);
    expect(chain.sent.map((s) => s.lamports)).toEqual([BigInt(25_000_000)]);
  });

  it("does not run until the Commons token row exists", async () => {
    await pending(25_000_000);
    chain.balances.set(treasury, 1_000_000_000);
    await db.update(tokens).set({ routeAddress: "moved" }).where(eq(tokens.id, "tok_fee-router"));
    const lines: string[] = [];
    try {
      await forwardCommonsShare((m) => lines.push(m));
    } finally {
      await db.update(tokens).set({ routeAddress: route }).where(eq(tokens.id, "tok_fee-router"));
    }
    expect(chain.sent).toHaveLength(0);
    expect(lines).toEqual([`skipped: no Commons token row on route ${route}`]);
  });
});
