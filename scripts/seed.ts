/**
 * Local demo seed. Deterministic (fixed PRNG) so pages look the same on every machine.
 * Signatures/addresses here are synthetic — the local ledger is a rehearsal, not chain state.
 *
 *   pnpm db:push && pnpm db:seed
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { db } from "../src/lib/db";
import { causes, deliveries, deliveryAllocations, feeEvents, periods, receiptArtifacts, sweeps, tokens, users, vaults } from "../src/lib/db/schema";
import { createHash } from "node:crypto";

let seed = 0x5eed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);

const fakeSig = () => bs58.encode(Uint8Array.from({ length: 64 }, () => Math.floor(rand() * 256)));
const addr = () => Keypair.generate().publicKey.toBase58();
const id = (p: string) => `${p}_${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")}`;
const daysAgo = (d: number, hourJitter = true) => new Date(Date.now() - d * 86_400_000 - (hourJitter ? rand() * 86_400_000 : 0));

const SOL = "So11111111111111111111111111111111111111112";
const SOL_PRICE = 178.4;

async function main() {
  await db.delete(receiptArtifacts);
  await db.delete(deliveryAllocations);
  await db.delete(deliveries);
  await db.delete(sweeps);
  await db.delete(feeEvents);
  await db.delete(periods);
  await db.delete(tokens);
  await db.delete(vaults);
  await db.delete(causes);
  await db.delete(users);

  const now = new Date();
  const operator = { id: "usr_operator", googleSub: "seed-operator", email: "ops@example.com", emailVerified: true, name: "Fee Router Operations", avatarUrl: null, walletAddress: addr(), role: "operator" as const, createdAt: daysAgo(90), lastLoginAt: daysAgo(0.5) };
  await db.insert(users).values(operator);

  const causeRows = [
    {
      id: "cau_hope_ward",
      slug: "hope-ward",
      title: "Hope Ward: pediatric cancer treatment",
      summary: "Chemotherapy and surgery for children whose families cannot pay.",
      story:
        "Hope Ward is the pediatric oncology unit of a public hospital. Treatment is free on paper, but families pay for the drugs the hospital runs out of, and a full course of chemotherapy costs more than most of them earn in a year. The ward's fundraiser is on GoFundMe, which does not accept crypto. Fee Router converts community token revenue to USDC, delivers it through a card, and publishes a receipt for every dollar.",
      beneficiary: "Hope Ward patients' families (verified by the ward's social worker)",
      platform: "gofundme" as const,
      url: "https://www.gofundme.com/f/hope-ward-demo",
      onchainAddress: null,
      goalUsd: 850_000,
      raisedExternalUsd: 212_880,
      currency: "USD",
      imageUrl: "/seed/hope-ward.svg",
      location: "Alexandria, Egypt",
      category: "medical",
      verificationStatus: "verified" as const,
      verificationNote: "Organizer identity confirmed via video call; hospital letter on file; GoFundMe campaign is under the organizer's verified account.",
      verifiedAt: daysAgo(31),
      createdBy: operator.id,
      createdAt: daysAgo(33),
    },
    {
      id: "cau_well",
      slug: "sindh-water-wells",
      title: "Twelve solar wells for Sindh villages",
      summary: "Clean water for ~9,000 people. LaunchGood campaign, card-only.",
      story: "Villages in Tharparkar walk hours for brackish water. Each solar-powered well costs about $4,200 and serves 700 people. The charity accepts cards through LaunchGood only.",
      beneficiary: "Alkhidmat Foundation (registered charity)",
      platform: "launchgood" as const,
      url: "https://www.launchgood.com/campaign/solar_wells_sindh",
      onchainAddress: null,
      goalUsd: 50_400,
      raisedExternalUsd: 18_200,
      currency: "USD",
      imageUrl: "/seed/wells.svg",
      location: "Sindh, Pakistan",
      category: "water",
      verificationStatus: "verified" as const,
      verificationNote: "Registered charity; campaign page matches charity's official site.",
      verifiedAt: daysAgo(20),
      createdBy: operator.id,
      createdAt: daysAgo(22),
    },
    {
      id: "cau_school",
      slug: "rebuild-el-nour-school",
      title: "Rebuild El Nour primary school",
      summary: "Accepts USDC directly. Delivered on-chain, no card needed.",
      story: "The school's roof collapsed in the winter storms. The NGO running it accepts USDC on Solana, so every delivery is a single on-chain transfer.",
      beneficiary: "El Nour Education Trust",
      platform: "onchain" as const,
      url: "https://elnour.org/rebuild",
      onchainAddress: addr(),
      goalUsd: 85_000,
      raisedExternalUsd: 9_400,
      currency: "USD",
      imageUrl: "/seed/school.svg",
      location: "Beirut, Lebanon",
      category: "education",
      verificationStatus: "pending" as const,
      verificationNote: null,
      verifiedAt: null,
      createdBy: operator.id,
      createdAt: daysAgo(6),
    },
  ];
  await db.insert(causes).values(causeRows);

  const vaultRows = [
    { id: "vlt_hope_ward", slug: "hope-ward", name: "Hope Ward Vault", tagline: "Every trade is a dose closer.", causeId: "cau_hope_ward", ownerUserId: operator.id, treasuryAddress: addr(), status: "active" as const, donateBps: 10000, deliveryThresholdUsd: 500, createdAt: daysAgo(31) },
    { id: "vlt_wells", slug: "wells", name: "Wells Vault", tagline: "Trade $WATER, dig wells.", causeId: "cau_well", ownerUserId: operator.id, treasuryAddress: addr(), status: "active" as const, donateBps: 10000, deliveryThresholdUsd: 250, createdAt: daysAgo(20) },
    { id: "vlt_school", slug: "el-nour", name: "El Nour Vault", tagline: "On-chain, end to end.", causeId: "cau_school", ownerUserId: operator.id, treasuryAddress: addr(), status: "active" as const, donateBps: 9000, deliveryThresholdUsd: 100, createdAt: daysAgo(6) },
  ];
  await db.insert(vaults).values(vaultRows);

  const tokenRows = [
    { id: "tok_cure", vaultId: "vlt_hope_ward", mint: addr(), symbol: "CURE", name: "Cure", imageUrl: "/seed/tok-cure.svg", source: "pumpfun" as const, launchpadUrl: "https://pump.fun/coin/", creatorWallet: addr(), routeAddress: addr(), routeBps: 10000, routeLocked: true, routeProofTx: fakeSig(), launchedViaFeeRouter: true, createdAt: daysAgo(30) },
    { id: "tok_hope", vaultId: "vlt_hope_ward", mint: addr(), symbol: "HOPE", name: "Hope", imageUrl: "/seed/tok-hope.svg", source: "bags" as const, launchpadUrl: "https://bags.fm/", creatorWallet: addr(), routeAddress: addr(), routeBps: 5000, routeLocked: true, routeProofTx: fakeSig(), launchedViaFeeRouter: false, createdAt: daysAgo(24) },
    { id: "tok_dose", vaultId: "vlt_hope_ward", mint: addr(), symbol: "DOSE", name: "One Dose", imageUrl: "/seed/tok-dose.svg", source: "pumpfun" as const, launchpadUrl: "https://pump.fun/coin/", creatorWallet: addr(), routeAddress: addr(), routeBps: 10000, routeLocked: false, routeProofTx: null, launchedViaFeeRouter: true, createdAt: daysAgo(9) },
    { id: "tok_water", vaultId: "vlt_wells", mint: addr(), symbol: "WATER", name: "Water", imageUrl: "/seed/tok-water.svg", source: "bags" as const, launchpadUrl: "https://bags.fm/", creatorWallet: addr(), routeAddress: addr(), routeBps: 10000, routeLocked: true, routeProofTx: fakeSig(), launchedViaFeeRouter: true, createdAt: daysAgo(19) },
    { id: "tok_nour", vaultId: "vlt_school", mint: addr(), symbol: "NOUR", name: "El Nour", imageUrl: "/seed/tok-nour.svg", source: "pumpfun" as const, launchpadUrl: "https://pump.fun/coin/", creatorWallet: addr(), routeAddress: addr(), routeBps: 10000, routeLocked: true, routeProofTx: fakeSig(), launchedViaFeeRouter: true, createdAt: daysAgo(5) },
  ];
  await db.insert(tokens).values(tokenRows);

  // Fee events: bursty, decaying per token age.
  const weights: Record<string, number> = { tok_basma: 1, tok_hope: 0.55, tok_dose: 0.9, tok_water: 0.4, tok_nour: 0.6 };
  const feeRows: (typeof feeEvents.$inferInsert)[] = [];
  for (const t of tokenRows) {
    const ageDays = Math.floor((now.getTime() - t.createdAt.getTime()) / 86_400_000);
    for (let d = ageDays; d >= 0; d--) {
      const n = Math.floor(rand() * 9 * weights[t.id]) + (d < 3 ? 2 : 0);
      for (let i = 0; i < n; i++) {
        const sol = (0.05 + rand() * 2.4 * (d === ageDays ? 3 : 1)) * weights[t.id];
        const lamports = BigInt(Math.round(sol * 1e9));
        feeRows.push({ id: id("fee"), vaultId: t.vaultId, tokenId: t.id, txSig: fakeSig(), slot: 300_000_000 + Math.floor(rand() * 5_000_000), blockTime: daysAgo(d), assetMint: SOL, amountRaw: lamports.toString(), decimals: 9, amountUsd: Math.round(sol * SOL_PRICE * 100) / 100, kind: "creator_fee", sweepId: null, createdAt: daysAgo(d, false) });
      }
    }
  }
  for (let i = 0; i < feeRows.length; i += 200) await db.insert(feeEvents).values(feeRows.slice(i, i + 200));

  // Periods: weekly per vault.
  const periodRows: (typeof periods.$inferInsert)[] = [];
  for (const v of vaultRows) {
    let start = new Date(v.createdAt);
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    let n = 1;
    while (start < now) {
      const end = new Date(start.getTime() + 7 * 86_400_000);
      const fees = feeRows.filter((f) => f.vaultId === v.id && f.blockTime >= start && f.blockTime < end).reduce((a, f) => a + f.amountUsd, 0);
      periodRows.push({ id: `per_${v.slug}_${n}`, vaultId: v.id, label: `Week ${n}`, startsAt: start, endsAt: end, status: end < now ? "closed" : "open", feesUsd: Math.round(fees * 100) / 100, deliveredUsd: 0, createdAt: start });
      start = end;
      n++;
    }
  }
  await db.insert(periods).values(periodRows);

  // Deliveries: one per closed period with enough fees; allocations pro-rata by token fees in that period.
  const deliveryRows: (typeof deliveries.$inferInsert)[] = [];
  const allocRows: (typeof deliveryAllocations.$inferInsert)[] = [];
  const artifactRows: (typeof receiptArtifacts.$inferInsert)[] = [];
  for (const v of vaultRows) {
    const cause = causeRows.find((c) => c.id === v.causeId)!;
    let ordinal = 1;
    for (const p of periodRows.filter((x) => x.vaultId === v.id && x.status === "closed")) {
      const amount = Math.floor((p.feesUsd ?? 0) * (v.donateBps / 10000) * 0.985 * 100) / 100; // swap slippage
      if (amount < v.deliveryThresholdUsd) continue;
      const rail = cause.platform === "onchain" ? "onchain" : "operator_card";
      const deliveredAt = new Date(p.endsAt.getTime() + (6 + rand() * 30) * 3_600_000);
      const dId = `dlv_${v.slug}_${ordinal}`;
      const fx = 1;
      const platformFee = rail === "operator_card" ? Math.round(amount * 0.029 * 100) / 100 + 0.3 : null;
      const receiptHash = createHash("sha256").update(`${dId}:${amount}:${deliveredAt.toISOString()}`).digest("hex");
      deliveryRows.push({
        id: dId,
        ordinal,
        vaultId: v.id,
        causeId: v.causeId,
        periodId: p.id,
        rail,
        status: "delivered",
        amountUsdc: amount,
        amountFiat: amount,
        fiatCurrency: "USD",
        fxRate: fx,
        platformFeeFiat: platformFee,
        fundingTxSig: fakeSig(),
        railRef: rail === "onchain" ? fakeSig() : `Visa •••• 4821 · auth ${Math.floor(rand() * 900000 + 100000)}`,
        receiptHash,
        anchorTxSig: fakeSig(),
        executedByUserId: operator.id,
        notes: rail === "operator_card" ? `Donated on ${cause.platform} as "Fee Router — ${v.name} community". Card statement reconciled.` : "USDC transfer to cause treasury.",
        failureReason: null,
        queuedAt: p.endsAt,
        fundedAt: new Date(p.endsAt.getTime() + 2 * 3_600_000),
        deliveredAt,
      });
      p.deliveredUsd = amount;
      const perTok = tokenRows.filter((t) => t.vaultId === v.id).map((t) => ({ t, usd: feeRows.filter((f) => f.tokenId === t.id && f.blockTime >= p.startsAt && f.blockTime < p.endsAt).reduce((a, f) => a + f.amountUsd, 0) }));
      const total = perTok.reduce((a, x) => a + x.usd, 0);
      let assigned = 0;
      perTok.forEach((x, i) => {
        if (x.usd === 0) return;
        const share = i === perTok.length - 1 ? Math.round((amount - assigned) * 100) / 100 : Math.floor((amount * x.usd) / total * 100) / 100;
        assigned += share;
        allocRows.push({ deliveryId: dId, tokenId: x.t.id, amountUsdc: share });
      });
      const arts: (typeof receiptArtifacts.$inferInsert)[] =
        rail === "operator_card"
          ? [
              { id: id("art"), deliveryId: dId, kind: "screenshot", label: `${cause.platform} donation confirmation`, url: "/seed/receipt-screenshot.svg", sha256: createHash("sha256").update(dId + "shot").digest("hex"), bytes: 184_233, createdAt: deliveredAt },
              { id: id("art"), deliveryId: dId, kind: "confirmation_email", label: "Confirmation email (capture)", url: "/seed/receipt-screenshot.svg", sha256: createHash("sha256").update(dId + "mail").digest("hex"), bytes: 61_020, createdAt: deliveredAt },
              { id: id("art"), deliveryId: dId, kind: "card_statement", label: "Zentro card statement line", url: "/seed/receipt-statement.svg", sha256: createHash("sha256").update(dId + "stmt").digest("hex"), bytes: 42_110, createdAt: deliveredAt },
            ]
          : [{ id: id("art"), deliveryId: dId, kind: "onchain_tx", label: "USDC transfer", url: `https://solscan.io/tx/${fakeSig()}`, sha256: createHash("sha256").update(dId + "tx").digest("hex"), bytes: 0, createdAt: deliveredAt }];
      artifactRows.push(...arts);
      ordinal++;
    }
    // One in-flight delivery for the most active vault, so the operator desk has work.
    if (v.id === "vlt_hope_ward") {
      const open = periodRows.find((x) => x.vaultId === v.id && x.status === "open")!;
      deliveryRows.push({ id: `dlv_${v.slug}_${ordinal}`, ordinal, vaultId: v.id, causeId: v.causeId, periodId: open.id, rail: "operator_card", status: "funded", amountUsdc: 1_240.5, amountFiat: null, fiatCurrency: null, fxRate: null, platformFeeFiat: null, fundingTxSig: fakeSig(), railRef: null, receiptHash: null, anchorTxSig: null, executedByUserId: null, notes: null, failureReason: null, queuedAt: daysAgo(0.4, false), fundedAt: daysAgo(0.3, false), deliveredAt: null });
      const perTok = tokenRows.filter((t) => t.vaultId === v.id);
      const shares = [620.25, 310.13, 310.12];
      perTok.forEach((t, i) => allocRows.push({ deliveryId: `dlv_${v.slug}_${ordinal}`, tokenId: t.id, amountUsdc: shares[i] }));
    }
  }
  await db.insert(deliveries).values(deliveryRows);
  await db.insert(deliveryAllocations).values(allocRows);
  await db.insert(receiptArtifacts).values(artifactRows);
  for (const p of periodRows) await db.update(periods).set({ deliveredUsd: p.deliveredUsd }).where(eq(periods.id, p.id!));

  console.log(`seeded: ${causeRows.length} causes, ${vaultRows.length} vaults, ${tokenRows.length} tokens, ${feeRows.length} fee events, ${deliveryRows.length} deliveries`);
}

import { eq } from "drizzle-orm";
main().then(() => process.exit(0));
