import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { ApiError, assertVaultOwner, fail, httpUrl, ok, parseBody, requireApiSession, route } from "@/app/api/_lib";
import { db } from "@/lib/db";
import { launches, vaults } from "@/lib/db/schema";
import { configured } from "@/lib/env";
import { generateKey, loadKeypair } from "@/lib/keys";
import { createPumpToken, pumpCreateBudgetSol, pumpfunCreatorRewardsUrl } from "@/lib/launchpads/pumpfun";
import { finishLaunch, fundLaunch, mergeLaunchMeta, unresolvedLaunch, type LaunchMeta } from "@/lib/launchpads/recovery";
import { withLock } from "@/lib/ledger/locks";
import { solBalance } from "@/lib/solana/transfer";
import { readImageByUrl, UploadError, type ImageBytes } from "@/lib/uploads";
import { RPC_NOT_CONFIGURED } from "@/lib/wallet";

const Body = z.object({
  vaultId: z.string().min(1),
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(10).regex(/^[A-Za-z0-9]+$/, "letters and digits only"),
  description: z.string().min(1).max(1000),
  /** From POST /api/uploads; must point at our own image store. */
  imageUrl: z.string().startsWith("/api/files/images/", "upload the image first"),
  devBuySol: z.number().min(0).max(50).default(0.1),
  website: httpUrl.optional(),
  twitter: z.string().max(64).optional(),
});

/** SOL the user's wallet must hold on top of the launch budget: the funding transfer fee and a margin so the wallet is not emptied. */
export const LAUNCH_WALLET_MARGIN_SOL = 0.005;

/**
 * Launch a token on pump.fun with attribution by construction:
 *   1. mint the Fee Router route key; it will be the token's *creator*, so creator fees accrue to it forever
 *   2. the user's custodial wallet funds the route key with devBuy + rent reserve
 *   3. metadata to pump.fun IPFS, create tx from PumpPortal, signed by the route key + the mint key
 *   4. register the token on its vault: source pumpfun, route locked, proof = the create signature
 * One request; the client polls GET /api/launch/[id] only to re-render after a reload. A launch this
 * request cannot finish is resolved by `launchRecoveryStep`: registered if the mint exists, else refunded.
 */
export const POST = route(async (req) => {
  const session = await requireApiSession();
  if (!configured.kms) return fail("KMS not configured", 503);
  if (!configured.rpc) return fail(RPC_NOT_CONFIGURED, 503);
  const body = await parseBody(req, Body);
  const vault = await db.select().from(vaults).where(eq(vaults.id, body.vaultId)).get();
  if (!vault) throw new ApiError("Vault not found", 404);
  assertVaultOwner(session, vault);

  let image: ImageBytes;
  try {
    image = await readImageByUrl(body.imageUrl);
  } catch (e) {
    if (e instanceof UploadError) return fail(e.message, e.status);
    throw e;
  }

  const budgetSol = pumpCreateBudgetSol(body.devBuySol);
  const needSol = budgetSol + LAUNCH_WALLET_MARGIN_SOL;
  const payer = await loadKeypair(session.user.walletAddress);
  const haveSol = await solBalance(payer.publicKey);
  if (haveSol < needSol) return fail(`Fund your wallet with at least ${needSol.toFixed(3)} SOL to launch (${body.devBuySol} SOL dev buy + ${(budgetSol - body.devBuySol).toFixed(3)} SOL rent and fees); it holds ${haveSol.toFixed(4)} SOL`, 402);

  const launchId = `lch_${nanoid(12)}`;
  const base = { name: body.name, symbol: body.symbol, imageUrl: body.imageUrl, description: body.description, devBuySol: body.devBuySol, website: body.website, twitter: body.twitter, routeBps: 10000 };
  // A double submit, a retry after a client timeout, or a retry after a failure whose create may still land must not fund and create a second token.
  const unresolved = await withLock(`launch:${session.user.id}`, async () => {
    const pending = await db.select({ id: launches.id, meta: launches.meta }).from(launches).where(and(eq(launches.userId, session.user.id), unresolvedLaunch)).get();
    if (pending) return pending;
    await db.insert(launches).values({ id: launchId, userId: session.user.id, vaultId: vault.id, launchpad: "pumpfun", status: "draft", meta: base, createdAt: new Date() });
    return null;
  });
  if (unresolved) {
    const manual = (unresolved.meta as LaunchMeta).recovery === "manual";
    return fail(manual ? `Launch ${unresolved.id} is held for review by the Fee Router team; you can launch again once it is resolved` : `Launch ${unresolved.id} is not finished: it goes live or its SOL is refunded to your wallet within minutes; launch again after that`, 409);
  }

  let funding = false;
  try {
    const { address: routeAddress } = await generateKey("token_route", launchId);
    await mergeLaunchMeta(launchId, { routeAddress });
    const creator = await loadKeypair(routeAddress);

    funding = true;
    await fundLaunch(launchId, session.user.id, payer, routeAddress, Math.round(budgetSol * 1e9));
    await createPumpToken({
      name: body.name,
      symbol: body.symbol,
      description: body.description,
      image: { bytes: image.body, mime: image.mime },
      website: body.website,
      twitter: body.twitter,
      creator,
      devBuySol: body.devBuySol,
      onSigned: (s) => mergeLaunchMeta(launchId, { mint: s.mint, createSig: s.signature, createLastValidBlockHeight: s.lastValidBlockHeight, metadataUrl: s.metadataUri }),
    });
    const { token, mint, signatures } = await finishLaunch(launchId);
    return ok({ launchId, mint, sigs: signatures, tokenId: token.id, routeAddress, vaultSlug: vault.slug, launchpadUrl: pumpfunCreatorRewardsUrl(mint) }, { status: 201 });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(launches).set({ status: "failed", error }).where(eq(launches.id, launchId));
    return fail(funding ? `${error}. Fee Router finishes this launch on its own within minutes: the token is registered if it was created, otherwise the SOL is refunded to your wallet.` : error, 502);
  }
});
