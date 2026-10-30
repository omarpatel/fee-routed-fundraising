import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { explainMatch } from "@/lib/ai/reconcile";
import { db } from "@/lib/db";
import { causes, deliveries, users, vaults, type Cause, type CausePlatform, type Delivery } from "@/lib/db/schema";
import { configured, env, operatorEmails } from "@/lib/env";
import { findDonationEmail, operatorMailer, sendOperatorEmail } from "@/lib/google/gmail";
import { attachCardEvidence, attachEmailEvidence, finalizeDelivery, markExecuting, markFailed, markFunded, markNotified } from "@/lib/ledger";
import { receiptNo, usdCents } from "@/lib/format";
import { txSignedUsd, type ZentroTransaction } from "./client";
import { getZentroClient, withZentro, zentroCardId, ZentroNotConfiguredError } from "./session-store";

/**
 * operator_card automation around the one human tap:
 *   funding  → poll the Zentro top-up invoice; credited ⇒ `funded` + operator notified
 *   funded   → the operator donates on the platform; we match the card purchase ⇒ `executing`
 *   executing→ attach the card statement (+ the platform's confirmation email when Gmail is
 *              connected) and seal the receipt ⇒ `delivered`
 */

/** Merchant descriptors as they appear on the card statement. Platforms not listed derive theirs from the cause URL. */
export const MERCHANT_PATTERN: Partial<Record<CausePlatform, RegExp>> = {
  gofundme: /gofundme/i,
  launchgood: /launchgood/i,
  justgiving: /justgiving/i,
  gogetfunding: /gogetfunding/i,
  everyorg: /every\.?org/i,
};

/** A purchase must land within this long after funding to count as the delivery. */
export const MATCH_WINDOW_MS = 7 * 86_400_000;

/**
 * The statement descriptor to expect for a cause: the platform's, else derived from the cause URL's
 * second-level label (`https://www.gogetfunding.com/x` → /gogetfunding/i). Stripe links also accept
 * `stripe`. Never null: a purchase from an unknown merchant is never a match.
 */
export function merchantPattern(cause: Pick<Cause, "platform" | "url">): RegExp {
  const known = MERCHANT_PATTERN[cause.platform];
  if (known) return known;
  let label = "";
  try {
    const parts = new URL(cause.url).hostname.split(".").filter(Boolean);
    // `a.b.co.uk` → `co`; not worth a public-suffix list here, so take the label before a 2-letter second level.
    label = parts.length >= 3 && parts[parts.length - 2].length <= 2 ? parts[parts.length - 3] : (parts[parts.length - 2] ?? parts[0] ?? "");
  } catch {
    label = "";
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (cause.platform === "stripe_link") return escaped ? new RegExp(`stripe|${escaped}`, "i") : /stripe/i;
  // No usable label (bad URL): a pattern that matches nothing — not even "" — so nothing is ever mis-attributed.
  return escaped ? new RegExp(escaped, "i") : /(?!)/;
}

const PLATFORM_NAME: Record<CausePlatform, string> = { gofundme: "GoFundMe", launchgood: "LaunchGood", justgiving: "JustGiving", gogetfunding: "GoGetFunding", everyorg: "Every.org", stripe_link: "Stripe link", onchain: "On-chain USDC", other: "the platform" };

/** Zentro's deposit invoice stays payable a while after `expires_in_seconds`; wait this long before giving up on a credited-late deposit. */
const BRIDGE_GRACE_MS = 2 * 3_600_000;

export interface PurchaseMatch {
  tx: ZentroTransaction;
  id: string;
  merchant: string;
  amountUsd: number;
  at: Date;
}

/** Stable id for a statement line: the issuer's, else the chain hash, else date+merchant+amount. */
function txId(tx: ZentroTransaction): string {
  if (typeof tx.id === "string" && tx.id) return tx.id;
  if (typeof tx.txHash === "string" && tx.txHash) return tx.txHash;
  return `${tx.date}|${tx.merchant ?? tx.description ?? ""}|${tx.amount}`;
}

/**
 * Pure: the card purchase that corresponds to a delivery. A purchase qualifies when it is after
 * funding and within `MATCH_WINDOW_MS`, not declined, not already attached to another delivery,
 * from the cause's merchant, and within max($1, 3%) of the delivery amount. Ties resolve to the
 * closest amount, then the earliest purchase. An unfunded delivery matches nothing.
 */
export function matchPurchase(delivery: { amountUsdc: number; fundedAt: Date | null }, cause: Pick<Cause, "platform" | "url">, history: ZentroTransaction[], usedCardTxIds: ReadonlySet<string> = new Set()): PurchaseMatch | null {
  if (!delivery.fundedAt) return null;
  const after = delivery.fundedAt.getTime();
  const until = after + MATCH_WINDOW_MS;
  const tolerance = Math.max(1, delivery.amountUsdc * 0.03);
  const merchantRe = merchantPattern(cause);
  let best: (PurchaseMatch & { diff: number }) | null = null;
  for (const tx of history) {
    if (tx.kind !== "purchase") continue;
    if (tx.status && /declin|fail|revers|cancel/i.test(tx.status)) continue;
    const id = txId(tx);
    if (usedCardTxIds.has(id)) continue;
    const at = new Date(tx.date);
    const t = at.getTime();
    if (!Number.isFinite(t) || t <= after || t > until) continue;
    const merchant = String(tx.merchant ?? tx.description ?? "");
    if (!merchantRe.test(merchant)) continue;
    const amountUsd = Math.abs(txSignedUsd(tx));
    const diff = Math.abs(amountUsd - delivery.amountUsdc);
    // An unparseable amount gives NaN, which passes `diff > tolerance` and would match any delivery.
    if (!Number.isFinite(diff) || diff > tolerance) continue;
    if (!best || diff < best.diff || (diff === best.diff && at < best.at)) best = { tx, id, merchant, amountUsd, at, diff };
  }
  if (!best) return null;
  return { tx: best.tx, id: best.id, merchant: best.merchant, amountUsd: best.amountUsd, at: best.at };
}

/** Every card tx id already attached to a delivery other than `exceptDeliveryId`. */
async function cardTxIdsInUse(exceptDeliveryId: string): Promise<Set<string>> {
  const rows = await db.select({ id: deliveries.id, cardTxId: deliveries.cardTxId }).from(deliveries).where(isNotNull(deliveries.cardTxId));
  const used = new Set<string>();
  for (const r of rows) if (r.id !== exceptDeliveryId && r.cardTxId) used.add(r.cardTxId);
  return used;
}

/* ------------------------------------------------------------------ */
/* Bridge polling                                                       */
/* ------------------------------------------------------------------ */

export interface BridgeCheck {
  delivery: Delivery;
  outcome: "waiting" | "funded" | "failed";
  detail: string;
}

/**
 * Poll the delivery's top-up invoice and advance the ledger. Card credited ⇒ `funded` and the operator is notified.
 * A top-up whose own USDC transfer is not confirmed yet belongs to `settleUnconfirmedFunding`: judging the
 * invoice now could fail it as "USDC was sent" (stranding the amount) when the transfer may never land.
 */
export async function checkBridge(delivery: Delivery): Promise<BridgeCheck> {
  if (delivery.status !== "funding" || !delivery.bridgeId) throw new Error(`Delivery ${delivery.id} is ${delivery.status}; nothing to poll`);
  if (delivery.fundingLastValidBlockHeight !== null) return { delivery, outcome: "waiting", detail: `funding transfer ${delivery.fundingTxSig ?? "(unsigned)"} not confirmed on-chain yet; the worker settles it first` };
  const s = await withZentro((c) => c.depositStatus(delivery.bridgeId!));
  const status = String(s.status ?? "");
  if (/complet|success|credited/i.test(status)) {
    const funded = await markFunded(delivery.id, delivery.fundingTxSig!, status);
    const note = await notifyOperator(funded);
    return { delivery: note.delivery, outcome: "funded", detail: `Zentro credited the card (${status}); ${note.sent ? `operator notified at ${note.recipients.join(", ")}` : `notification not sent: ${note.reason}`}` };
  }
  if (/fail|expired|cancel|reject/i.test(status)) {
    const reason = `Zentro top-up ${delivery.bridgeId} ${status}; USDC was sent in ${delivery.fundingTxSig}. Contact Zentro support with the bridge id.`;
    return { delivery: await markFailed(delivery.id, reason), outcome: "failed", detail: reason };
  }
  if (delivery.bridgeExpiresAt && delivery.bridgeExpiresAt.getTime() + BRIDGE_GRACE_MS < Date.now()) {
    const reason = `Zentro top-up ${delivery.bridgeId} still "${status}" ${BRIDGE_GRACE_MS / 3_600_000}h after the invoice expired; USDC was sent in ${delivery.fundingTxSig}. Contact Zentro support with the bridge id.`;
    return { delivery: await markFailed(delivery.id, reason), outcome: "failed", detail: reason };
  }
  await db.update(deliveries).set({ bridgeStatus: status || "waiting" }).where(eq(deliveries.id, delivery.id));
  return { delivery: { ...delivery, bridgeStatus: status || "waiting" }, outcome: "waiting", detail: `bridge ${status || "waiting"}` };
}

/* ------------------------------------------------------------------ */
/* Operator notification                                                */
/* ------------------------------------------------------------------ */

async function context(delivery: Delivery) {
  const cause = (await db.select().from(causes).where(eq(causes.id, delivery.causeId)).get())!;
  const vault = (await db.select().from(vaults).where(eq(vaults.id, delivery.vaultId)).get())!;
  return { cause, vault, displayName: `Fee Router — ${vault.name} community` };
}

export interface NotifyResult {
  delivery: Delivery;
  sent: boolean;
  recipients: string[];
  reason: string;
}

/** Email every OPERATOR_EMAILS address that the card is funded and a tap is due. Sends as the connected operator's Gmail. */
export async function notifyOperator(delivery: Delivery): Promise<NotifyResult> {
  const recipients = [...operatorEmails];
  if (recipients.length === 0) return { delivery, sent: false, recipients, reason: "OPERATOR_EMAILS not configured" };
  const mailer = await operatorMailer();
  if (!mailer) return { delivery, sent: false, recipients, reason: "Gmail not connected: no operator has signed in with Gmail scopes" };
  const { cause, vault, displayName } = await context(delivery);
  const amount = usdCents(delivery.amountUsdc);
  const ops = `${env.NEXT_PUBLIC_SITE_URL}/ops`;
  const subject = `Fee Router · ${receiptNo(delivery.ordinal)} is funded — tap to deliver ${amount} to ${cause.title}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = [
    `<p>The Fee Router card is funded for <strong>${receiptNo(delivery.ordinal)}</strong> (${esc(vault.name)} → ${esc(cause.title)}).</p>`,
    `<table style="font-family:monospace;font-size:13px;border-collapse:collapse">`,
    `<tr><td style="padding:2px 12px 2px 0;color:#666">Amount</td><td><strong>${amount}</strong></td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#666">Platform</td><td>${PLATFORM_NAME[cause.platform]}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#666">Fundraiser</td><td><a href="${esc(cause.url)}">${esc(cause.url)}</a></td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#666">Display name</td><td>${esc(displayName)}</td></tr>`,
    `</table>`,
    `<p>Donate the exact amount with the Fee Router card using that display name. The purchase is detected on the card automatically; nothing else to do.</p>`,
    `<p><a href="${ops}">Open the operator desk</a></p>`,
  ].join("\n");
  await sendOperatorEmail(mailer.userId, recipients, subject, html);
  await markNotified(delivery.id);
  return { delivery: { ...delivery, notifiedAt: new Date() }, sent: true, recipients, reason: "" };
}

/* ------------------------------------------------------------------ */
/* Purchase reconciliation + evidence                                   */
/* ------------------------------------------------------------------ */

export interface ReconcileResult {
  delivery: Delivery;
  outcome: "waiting" | "delivered";
  detail: string;
}

/**
 * Match the operator's card purchase, attach evidence, seal the receipt. Safe to re-run: an
 * `executing` delivery (matched earlier, evidence step interrupted) resumes at the evidence step.
 */
export async function reconcileDelivery(delivery: Delivery): Promise<ReconcileResult> {
  if (delivery.status !== "funded" && delivery.status !== "executing") throw new Error(`Delivery ${delivery.id} is ${delivery.status}; expected funded or executing`);
  const { cause, displayName } = await context(delivery);
  const { history, last4 } = await withZentro(async (c) => {
    const cardId = await zentroCardId(c);
    const hist = await c.history(cardId);
    const card = await c.card(cardId);
    const l4 = typeof card.last4 === "string" ? card.last4 : card.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : "????";
    return { history: hist, last4: l4 };
  });

  let cur = delivery;
  let match: PurchaseMatch | null;
  if (cur.status === "funded") {
    match = matchPurchase({ amountUsdc: cur.amountUsdc, fundedAt: cur.fundedAt }, cause, history, await cardTxIdsInUse(cur.id));
    if (!match) return { delivery: cur, outcome: "waiting", detail: `no ${PLATFORM_NAME[cause.platform]} purchase of ~${usdCents(cur.amountUsdc)} on the card since ${cur.fundedAt?.toISOString() ?? "funding"}` };
    cur = await markExecuting(cur.id, { cardTxId: match.id, cardTxMerchant: match.merchant, cardTxAt: match.at });
  } else {
    const tx = history.find((t) => txId(t) === cur.cardTxId);
    match = tx ? { tx, id: txId(tx), merchant: String(tx.merchant ?? tx.description ?? cur.cardTxMerchant ?? ""), amountUsd: Math.abs(txSignedUsd(tx)), at: new Date(tx.date) } : null;
  }

  const merchant = match?.merchant ?? cur.cardTxMerchant ?? PLATFORM_NAME[cause.platform];
  const amountUsd = match?.amountUsd ?? cur.amountFiat ?? cur.amountUsdc;
  if (match) await attachCardEvidence(cur.id, `Zentro card · ${merchant} · ${usdCents(amountUsd)}`, match.tx);

  const notes: string[] = [`Donated on ${PLATFORM_NAME[cause.platform]} as "${displayName}" with the Fee Router card. Card statement reconciled automatically.`];
  const mailer = await operatorMailer();
  let emailText: string | null = null;
  if (!mailer) notes.push("Gmail not connected; platform confirmation not harvested.");
  else {
    try {
      const mail = await findDonationEmail(mailer.userId, { platform: cause.platform, amountUsd, after: cur.fundedAt ?? cur.queuedAt });
      if (mail) {
        await attachEmailEvidence(cur.id, `${PLATFORM_NAME[cause.platform]} confirmation · ${mail.subject || mail.from}`.slice(0, 120), mail.raw);
        notes.push(`Confirmation email "${mail.subject}" from ${mail.from} attached.`);
        emailText = `Subject: ${mail.subject}\nFrom: ${mail.from}\nDate: ${mail.date.toISOString()}\n\n${mail.raw.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000)}`;
      } else notes.push(`No ${PLATFORM_NAME[cause.platform]} confirmation email found in ${mailer.email} yet.`);
    } catch (e) {
      notes.push(`Confirmation email lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Advisory rationale from Claude, when configured. A failure here is a note, never a blocked receipt.
  if (match) {
    try {
      const why = await explainMatch(cur, PLATFORM_NAME[cause.platform], { id: match.id, merchant: match.merchant, amountUsd: match.amountUsd, at: match.at }, emailText);
      if (why) notes.push(`Claude (${why.confidence} confidence): ${why.rationale}`);
    } catch (e) {
      notes.push(`Claude rationale unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const operator = mailer ? { id: mailer.userId } : await db.select({ id: users.id }).from(users).where(inArray(users.email, [...operatorEmails].length ? [...operatorEmails] : ["-"])).get();
  const done = await finalizeDelivery(cur.id, {
    railRef: `Visa •••• ${last4} · ${merchant} · ${cur.cardTxId ?? match?.id ?? ""}`,
    amountFiat: amountUsd,
    fiatCurrency: "USD",
    fxRate: 1,
    platformFeeFiat: null,
    notes: notes.join(" "),
    executedByUserId: operator?.id ?? null,
  });
  return { delivery: done, outcome: "delivered", detail: `matched ${merchant} ${usdCents(amountUsd)} (${cur.cardTxId}); receipt ${done.receiptHash?.slice(0, 12)}…${mailer ? "" : " · Gmail not connected"}` };
}

/* ------------------------------------------------------------------ */
/* Worker steps                                                         */
/* ------------------------------------------------------------------ */

type Log = (msg: string) => void;

/** Why the Zentro steps cannot run right now, or null when they can. */
async function zentroSkipReason(): Promise<string | null> {
  if (!configured.kms) return "FEE_ROUTER_KMS_KEY not configured";
  try {
    await getZentroClient();
    return null;
  } catch (e) {
    if (e instanceof ZentroNotConfiguredError) return e.message;
    throw e;
  }
}

/** Worker: poll every `funding` card delivery. */
export async function zentroBridgesStep(log: Log): Promise<void> {
  const rows = await db.select().from(deliveries).where(and(eq(deliveries.rail, "operator_card"), eq(deliveries.status, "funding"), isNull(deliveries.fundingLastValidBlockHeight)));
  if (rows.length === 0) return log("no card top-ups in flight");
  const skip = await zentroSkipReason();
  if (skip) return log(`${rows.length} top-up(s) waiting; skipped: ${skip}`);
  for (const d of rows) {
    try {
      const r = await checkBridge(d);
      log(`${d.id}: ${r.outcome} · ${r.detail}`);
    } catch (e) {
      log(`${d.id}: check failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Worker: notify unnotified funded deliveries, then try to match each funded/executing card delivery. */
export async function zentroReconcileStep(log: Log): Promise<void> {
  const unnotified = await db.select().from(deliveries).where(and(eq(deliveries.rail, "operator_card"), eq(deliveries.status, "funded"), isNull(deliveries.notifiedAt)));
  for (const d of unnotified) {
    try {
      const n = await notifyOperator(d);
      log(n.sent ? `${d.id}: operator notified (${n.recipients.join(", ")})` : `${d.id}: not notified: ${n.reason}`);
    } catch (e) {
      log(`${d.id}: notify failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const rows = await db.select().from(deliveries).where(and(eq(deliveries.rail, "operator_card"), inArray(deliveries.status, ["funded", "executing"])));
  if (rows.length === 0) return log("no card deliveries awaiting a purchase");
  const skip = await zentroSkipReason();
  if (skip) return log(`${rows.length} card delivery(ies) waiting; skipped: ${skip}`);
  for (const d of rows) {
    try {
      const r = await reconcileDelivery(d);
      log(`${d.id}: ${r.outcome} · ${r.detail}`);
    } catch (e) {
      log(`${d.id}: reconcile failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
