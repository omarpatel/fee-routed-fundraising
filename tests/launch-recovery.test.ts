import { Keypair } from "@solana/web3.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RpcModule from "@/lib/solana/rpc";
import type * as UploadsModule from "@/lib/uploads";

/** Stub chain: balances, existing mints, signature statuses and block height are set per test; every broadcast is recorded. No network. */
const chain = vi.hoisted(() => ({
  height: 1000,
  balances: new Map<string, number>(),
  mints: new Set<string>(),
  statuses: new Map<string, { err: unknown; confirmationStatus: string }>(),
  history: new Map<string, string[]>(),
  /** Broadcast transactions: fee payer and signature. */
  sent: [] as { from: string; sig: string }[],
  /** "ok" lands the transfer; "ambiguous" drops the connection after the send (it may have landed). */
  send: "ok" as "ok" | "ambiguous",
}));
vi.mock("@/lib/solana/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof RpcModule>();
  type Pk = { toBase58(): string };
  const conn = {
    getBalance: async (pk: Pk) => chain.balances.get(pk.toBase58()) ?? 0,
    getAccountInfo: async (pk: Pk) => (chain.mints.has(pk.toBase58()) ? { lamports: 1_461_600, data: Buffer.alloc(82) } : null),
    getBlockHeight: async () => chain.height,
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => chain.statuses.get(s) ?? null) }),
    getSignaturesForAddress: async (pk: Pk) => (chain.history.get(pk.toBase58()) ?? []).map((signature) => ({ signature })),
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: chain.height + 150 }),
    sendRawTransaction: async (raw: Buffer) => {
      // Dynamic: a vi.mock factory is hoisted above this file's static imports.
      const { Transaction } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;
      const tx = Transaction.from(raw);
      const sig = bs58.encode(tx.signature!);
      chain.sent.push({ from: tx.feePayer!.toBase58(), sig });
      if (chain.send === "ambiguous") throw new Error("socket hang up");
      return sig;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return { ...actual, rpc: () => conn };
});
/** In-memory stand-in for Next's request cookie jar (POST /api/launch needs a session). */
const jar = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return { get: (name: string) => (name in store ? { name, value: store[name] } : undefined), set: (name: string, value: string) => void (store[name] = value), delete: (name: string) => void delete store[name] };
});
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("@/lib/uploads", async (importOriginal) => ({ ...(await importOriginal<typeof UploadsModule>()), readImageByUrl: async () => ({ body: Buffer.from("png"), mime: "image/png", bytes: 3, ext: "png" }) }));

import { and, eq } from "drizzle-orm";
import { POST as launchPost } from "@/app/api/launch/route";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { causes, launches, protocolConfig, tokens, users, vaults, walletTransfers } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { generateKey } from "@/lib/keys";
import { launchRecoveryStep, mergeLaunchMeta, type LaunchMeta } from "@/lib/launchpads/recovery";
import { launchProtocolToken } from "@/lib/protocol";
import { SOL_MINT } from "@/lib/solana/rpc";
import { createUserWallet } from "@/lib/wallet";
import { rows } from "./fixtures";

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);
const log = () => {};
const landed = { err: null, confirmationStatus: "finalized" };

beforeAll(async () => {
  // `configured` is computed from the env at import; this file has no SOLANA_RPC_URL, so flip it for the stubbed chain.
  const flags: { rpc: boolean } = configured;
  flags.rpc = true;
  await db.insert(causes).values(rows.cause("cse_l"));
  await db.insert(vaults).values(rows.vault("vlt_l", "cse_l"));
});

beforeEach(() => {
  chain.height = 1000;
  chain.balances.clear();
  chain.mints.clear();
  chain.statuses.clear();
  chain.history.clear();
  chain.sent = [];
  chain.send = "ok";
});

let n = 0;
/** A user launch that funded its route key with 0.13 SOL and signed a create (expiry height 950) that has not been seen. */
async function fundedLaunch(over: { status?: "failed" | "config_created"; createdAt?: Date; meta?: Partial<LaunchMeta> } = {}) {
  const i = ++n;
  const userId = `usr_l${i}`;
  const walletAddress = await createUserWallet(userId);
  await db.insert(users).values({ id: userId, googleSub: `l${i}`, email: `l${i}@test.local`, walletAddress, createdAt: new Date(), lastLoginAt: new Date() });
  const id = `lch_${i}`;
  const { address: routeAddress } = await generateKey("token_route", id);
  const meta: LaunchMeta = {
    name: `Token ${i}`,
    symbol: `TK${i}`,
    imageUrl: "/api/files/images/x.png",
    routeBps: 10000,
    routeAddress,
    fundingSig: `fund${i}`,
    fundingLastValidBlockHeight: 900,
    fundedSol: 0.13,
    mint: Keypair.generate().publicKey.toBase58(),
    createSig: `create${i}`,
    createLastValidBlockHeight: 950,
    ...over.meta,
  };
  await db.insert(launches).values({ id, userId, vaultId: "vlt_l", launchpad: "pumpfun", status: over.status ?? "failed", error: "pump.fun create timed out", meta, createdAt: over.createdAt ?? HOUR_AGO() });
  await db.insert(walletTransfers).values({ id: `wtr_f${i}`, userId, kind: "launch_fee", assetMint: SOL_MINT, amountRaw: "130000000", toAddress: routeAddress, txSig: meta.fundingSig, lastValidBlockHeight: 900, status: "sent", createdAt: HOUR_AGO() });
  chain.statuses.set(meta.fundingSig!, landed);
  chain.balances.set(routeAddress, 130_000_000);
  chain.history.set(routeAddress, [meta.fundingSig!]);
  return { id, userId, walletAddress, routeAddress, meta };
}

const launchRow = async (id: string) => (await db.select().from(launches).where(eq(launches.id, id)).get())!;
const refundRows = (userId: string) => db.select().from(walletTransfers).where(and(eq(walletTransfers.userId, userId), eq(walletTransfers.kind, "launch_refund")));

describe("launchRecoveryStep", () => {
  it("refunds a funded launch whose create expired unseen, exactly once", async () => {
    const l = await fundedLaunch();

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].from).toBe(l.routeAddress);
    const [refund] = await refundRows(l.userId);
    // Everything on the route key minus the refund's own fee, to the launching user's wallet.
    expect(refund).toMatchObject({ status: "confirmed", amountRaw: String(130_000_000 - 5000), toAddress: l.walletAddress, txSig: chain.sent[0].sig });
    const launch = await launchRow(l.id);
    expect(launch.status).toBe("refunded");
    expect((launch.meta as LaunchMeta).refundSig).toBe(chain.sent[0].sig);
    expect((await db.select().from(walletTransfers).where(eq(walletTransfers.id, "wtr_f1")).get())?.status).toBe("confirmed");

    await launchRecoveryStep(log);
    // Even if the launch row had not been marked (crash after the send), the confirmed refund row stops a second send.
    await db.update(launches).set({ status: "failed" }).where(eq(launches.id, l.id));
    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);
    expect(await refundRows(l.userId)).toHaveLength(1);
    expect((await launchRow(l.id)).status).toBe("refunded");
  });

  it("registers the token when the mint exists, with the route key as locked creator", async () => {
    const l = await fundedLaunch();
    chain.mints.add(l.meta.mint!);

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(0);
    const token = await db.select().from(tokens).where(eq(tokens.mint, l.meta.mint!)).get();
    expect(token).toMatchObject({ vaultId: "vlt_l", routeAddress: l.routeAddress, creatorWallet: l.routeAddress, routeLocked: true, routeProofTx: l.meta.createSig, launchedViaFeeRouter: true, source: "pumpfun" });
    const launch = await launchRow(l.id);
    expect(launch).toMatchObject({ status: "launched", tokenId: token!.id, error: null });
    expect((launch.meta as LaunchMeta).signatures).toEqual([l.meta.fundingSig, l.meta.createSig]);
    expect(await refundRows(l.userId)).toHaveLength(0);
  });

  it("leaves in-window launches and creates that may still land untouched", async () => {
    const fresh = await fundedLaunch({ status: "config_created", createdAt: new Date() });
    const pending = await fundedLaunch({ meta: { createLastValidBlockHeight: 1200 } });

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(0);
    expect((await launchRow(fresh.id)).status).toBe("config_created");
    expect((await launchRow(pending.id)).status).toBe("failed");
    expect(await refundRows(fresh.userId)).toHaveLength(0);
    expect(await refundRows(pending.userId)).toHaveLength(0);

    // Past its expiry height with no trace, the create can never land: now it is refunded.
    chain.height = 1201;
    await launchRecoveryStep(log);
    expect(chain.sent.map((s) => s.from)).toEqual([pending.routeAddress]);
    expect((await launchRow(pending.id)).status).toBe("refunded");
  });

  it("does not re-send a refund whose confirmation was lost until it is known never to land", async () => {
    const l = await fundedLaunch();
    chain.send = "ambiguous";

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);
    const first = chain.sent[0].sig;
    expect((await refundRows(l.userId))[0]).toMatchObject({ status: "sent", txSig: first });
    expect((await launchRow(l.id)).status).toBe("failed");

    // Unseen but still inside its blockhash window: wait.
    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);

    // Past the window and unseen: it never moved anything, so the next run sends a fresh one.
    chain.height = 1151;
    chain.send = "ok";
    await launchRecoveryStep(log);
    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(2);
    const rowsNow = await refundRows(l.userId);
    expect(rowsNow).toHaveLength(1);
    expect(rowsNow[0]).toMatchObject({ status: "confirmed", txSig: chain.sent[1].sig });
    expect((await launchRow(l.id)).status).toBe("refunded");
  });

  it("settles a refund that landed after its send errored, without a second send", async () => {
    const l = await fundedLaunch();
    chain.send = "ambiguous";
    await launchRecoveryStep(log);
    chain.statuses.set(chain.sent[0].sig, landed);
    chain.height = 5000;

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);
    expect((await refundRows(l.userId))[0]).toMatchObject({ status: "confirmed", txSig: chain.sent[0].sig });
    expect((await launchRow(l.id)).status).toBe("refunded");
  });

  it("holds a route key with unexplained history for an operator instead of refunding", async () => {
    // A row from before create signatures were recorded: the create may have gone out.
    const l = await fundedLaunch({ meta: { createSig: undefined, createLastValidBlockHeight: undefined, mint: undefined } });
    chain.history.set(l.routeAddress, [l.meta.fundingSig!, "unknownCreate"]);

    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(0);
    const launch = await launchRow(l.id);
    expect(launch.status).toBe("failed");
    expect((launch.meta as LaunchMeta).recovery).toBe("manual");
  });

  it("$ROUTE: refunds only the funded amount from the treasury to the admin; registers and pins the mint when it exists", async () => {
    const adminWallet = await createUserWallet("usr_adm");
    await db.insert(users).values({ id: "usr_adm", googleSub: "adm", email: "admin@test.local", role: "admin", walletAddress: adminWallet, createdAt: new Date(), lastLoginAt: new Date() });
    const { address: treasury } = await generateKey("protocol_treasury", "protocol");
    chain.balances.set(treasury, 5_000_000_000); // fees the treasury already holds are not the admin's
    const launchAt = async (id: string, meta: Partial<LaunchMeta>) => {
      const { address: routeAddress } = await generateKey("token_route", id);
      await db.insert(launches).values({
        id,
        userId: "usr_adm",
        vaultId: "vlt_l",
        launchpad: "pumpfun",
        status: "failed",
        meta: { name: "Fee Router", symbol: "ROUTE", imageUrl: "/api/files/images/v.png", routeBps: 5000, routeAddress, protocol: true, creator: treasury, fundingSig: `${id}_fund`, fundingLastValidBlockHeight: 900, fundedSol: 0.53, mint: Keypair.generate().publicKey.toBase58(), createSig: `${id}_create`, createLastValidBlockHeight: 950, ...meta } satisfies LaunchMeta,
        createdAt: HOUR_AGO(),
      });
      chain.statuses.set(`${id}_fund`, landed);
      return { id, routeAddress, mint: (await launchRow(id)).meta.mint as string };
    };

    const dead = await launchAt("lch_v1", {});
    await launchRecoveryStep(log);
    expect(chain.sent.map((s) => s.from)).toEqual([treasury]);
    expect((await refundRows("usr_adm"))[0]).toMatchObject({ status: "confirmed", amountRaw: String(530_000_000 - 5000), toAddress: adminWallet });
    expect((await launchRow(dead.id)).status).toBe("refunded");

    const live = await launchAt("lch_v2", {});
    chain.mints.add(live.mint);
    await launchRecoveryStep(log);
    expect(chain.sent).toHaveLength(1);
    expect(await db.select().from(tokens).where(eq(tokens.mint, live.mint)).get()).toMatchObject({ routeAddress: live.routeAddress, creatorWallet: treasury, routeLocked: false, routeBps: 5000 });
    expect((await db.select().from(protocolConfig).where(eq(protocolConfig.key, "protocol_mint")).get())?.value).toBe(live.mint);
    expect((await launchRow(live.id)).status).toBe("launched");
  });
});

describe("a new launch waits for unresolved ones", () => {
  it("POST /api/launch refuses while an earlier failed launch may still create its token, and proceeds once recovery settles it", async () => {
    // Failed an hour ago (outside the in-flight window), but its create can land until height 1200.
    const l = await fundedLaunch({ meta: { createLastValidBlockHeight: 1200 } });
    await db.insert(vaults).values(rows.vault("vlt_own", "cse_l", { ownerUserId: l.userId }));
    chain.balances.set(l.walletAddress, 10_000_000_000);
    await createSession(l.userId, new Request("http://localhost/"));
    const post = async () => {
      const body = { vaultId: "vlt_own", name: "Second", symbol: "TWO", description: "A second token for the same cause.", imageUrl: "/api/files/images/x.png", devBuySol: 0.1 };
      const res = await launchPost(new Request("http://localhost/api/launch", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({}) });
      return { status: res.status, error: ((await res.json()) as { error?: string }).error };
    };
    const userLaunches = () => db.select().from(launches).where(eq(launches.userId, l.userId));

    const blocked = await post();
    expect(blocked.status).toBe(409);
    expect(blocked.error).toContain(l.id);
    expect(await userLaunches()).toHaveLength(1);
    expect(chain.sent).toHaveLength(0);

    chain.height = 1201;
    await launchRecoveryStep(log);
    expect((await launchRow(l.id)).status).toBe("refunded");

    // Settled: the next launch starts, funds its route key, then fails at pump.fun (no network here) after funding.
    vi.stubGlobal("fetch", async () => {
      throw new Error("network disabled in tests");
    });
    try {
      expect((await post()).status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
    const second = (await userLaunches()).find((x) => x.id !== l.id)!;
    expect(second.status).toBe("failed");
    // That funded, failed launch now blocks the one after it until recovery settles it too.
    const again = await post();
    expect(again.status).toBe(409);
    expect(again.error).toContain(second.id);
  });

  it("$ROUTE: refuses while an earlier $ROUTE launch is unresolved or held for review", async () => {
    await db.delete(protocolConfig).where(eq(protocolConfig.key, "protocol_mint"));
    await db.insert(users).values({ id: "usr_adm2", googleSub: "adm2", email: "admin2@test.local", role: "admin", walletAddress: await createUserWallet("usr_adm2"), createdAt: new Date(), lastLoginAt: new Date() });
    const meta: LaunchMeta = { name: "Fee Router", symbol: "ROUTE", imageUrl: "/api/files/images/v.png", routeBps: 5000, protocol: true, fundingSig: "g1_fund", fundedSol: 0.53, createSig: "g1_create", createLastValidBlockHeight: 1200 };
    await db.insert(launches).values({ id: "lch_g1", userId: "usr_adm2", vaultId: "vlt_l", launchpad: "pumpfun", status: "failed", meta, createdAt: HOUR_AGO() });
    const attempt = () => launchProtocolToken({ description: " ", imageUrl: "/api/files/images/v.png", image: { body: Buffer.from("png"), mime: "image/png", bytes: 3, ext: "png" }, devBuySol: 0, payerUserId: "usr_adm2" });

    await expect(attempt()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("lch_g1") });
    await mergeLaunchMeta("lch_g1", { recovery: "manual", recoveryNote: "check the treasury" });
    await expect(attempt()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/lch_g1.*manual review/) });
    await db.update(launches).set({ status: "refunded" }).where(eq(launches.id, "lch_g1"));
    // Past the guard: the next check refuses the blank description, before anything is funded.
    await expect(attempt()).rejects.toThrow("Description is required");
  });
});
