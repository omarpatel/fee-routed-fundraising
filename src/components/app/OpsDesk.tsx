"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, cx, Eyebrow, Panel, Pill, Row, Stamp, StatusPill } from "@/components/ui";
import { AllocationChips, CheckGlyph, ExternalLink, PLATFORM_LABEL, RailPill } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import type { OpsDelivery } from "@/lib/db/queries.app";
import type { Delivery, ReceiptArtifact } from "@/lib/db/schema";
import { dateTime, receiptNo, short, solscanAddr, solscanTx, timeAgo, usd, usdCents } from "@/lib/format";
import { api, sha256Hex } from "./api";
import { AddressBlock, Field, Input, Notice, Select, Textarea } from "./forms";

export interface OpsVault {
  id: string;
  slug: string;
  name: string;
  causeTitle: string;
  treasuryAddress: string;
  deliveryThresholdUsd: number;
  donateBps: number;
  feesUsd: number;
  deliveredUsd: number;
  pendingUsd: number;
  /** Failed/reversed after funding left the treasury, not yet recovered; still held against the balance. */
  strandedUsd: number;
}

/** Card rail state as the desk needs it (subset of `ZentroStatus`, no probe). */
export interface OpsZentro {
  sessionStored: boolean;
  canRelogin: boolean;
  last4: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface OpsDeskProps {
  open: OpsDelivery[];
  settled: OpsDelivery[];
  vaults: OpsVault[];
  zentro: OpsZentro;
  operatorName: string;
}

const ARTIFACT_KINDS: ReceiptArtifact["kind"][] = ["screenshot", "confirmation_email", "card_statement", "platform_receipt", "onchain_tx", "other"];
const ZENTRO_MIN_USD = 15;

export function OpsDesk({ open, settled, vaults, zentro, operatorName }: OpsDeskProps) {
  const [expanded, setExpanded] = useState<string | null>(open[0]?.delivery.id ?? null);
  const groups: { status: Delivery["status"]; rows: OpsDelivery[] }[] = (["funded", "executing", "funding", "queued"] as const).map((status) => ({ status, rows: open.filter((d) => d.delivery.status === status) })).filter((g) => g.rows.length > 0);
  const zentroReady = zentro.sessionStored || zentro.canRelogin;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_340px]">
      <div>
        <div className="flex items-end justify-between hairline-b pb-3 mb-4">
          <h2 className="font-display text-[26px] leading-none">Work queue</h2>
          <span className="font-mono text-[12px] text-muted">
            {open.length} open · {usdCents(open.reduce((s, d) => s + d.delivery.amountUsdc, 0))}
          </span>
        </div>
        {open.length === 0 ? (
          <Panel className="p-8 text-center">
            <p className="font-display text-[26px]">Queue is empty.</p>
            <p className="mt-2 text-[14px] text-muted">Deliveries appear here when a treasury crosses its threshold or you queue one manually.</p>
          </Panel>
        ) : (
          groups.map((g) => (
            <section key={g.status} className="mb-8">
              <div className="flex items-center gap-2 mb-2">
                <StatusPill status={g.status} />
                <span className="font-mono text-[11px] text-muted uppercase tracking-[0.12em]">
                  {g.rows.length} · {GROUP_HINT[g.status]}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {g.rows.map((d) => (
                  <DeliveryCard key={d.delivery.id} d={d} expanded={expanded === d.delivery.id} onToggle={() => setExpanded(expanded === d.delivery.id ? null : d.delivery.id)} zentro={zentro} operatorName={operatorName} />
                ))}
              </div>
            </section>
          ))
        )}

        <div className="flex items-end justify-between hairline-b pb-3 mb-4 mt-12">
          <h2 className="font-display text-[26px] leading-none">Recently settled</h2>
        </div>
        {settled.length === 0 ? (
          <p className="text-[13px] text-muted">Nothing settled yet.</p>
        ) : (
          <div className="flex flex-col">
            {settled.map((d) => (
              <div key={d.delivery.id} className="rule-dashed">
                <Link href={`/r/${d.delivery.id}`} className="grid grid-cols-[90px_1fr_auto] items-center gap-3 py-2.5 font-mono text-[12px] hover:bg-paper-2/60">
                  <span>{receiptNo(d.delivery.ordinal)}</span>
                  <span className="truncate">
                    {d.vault.name} → {d.cause.title}
                    <span className="text-muted" suppressHydrationWarning> · {d.delivery.deliveredAt ? timeAgo(d.delivery.deliveredAt) : ""}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {usdCents(d.delivery.amountUsdc)}
                    <StatusPill status={d.delivery.status} />
                  </span>
                  {d.delivery.failureReason ? <span className="col-span-3 whitespace-normal break-words text-stamp">{d.delivery.failureReason}</span> : null}
                </Link>
                {d.delivery.status !== "delivered" && d.delivery.fundingTxSig && !d.delivery.fundingRecoveredAt ? <RecoverForm d={d} /> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24 self-start">
        <QueueForm vaults={vaults} />
        <Panel className="p-5">
          <Eyebrow>Rails</Eyebrow>
          <div className="mt-1">
            <Row
              label="Zentro card"
              value={
                zentroReady ? (
                  <span className="inline-flex items-center gap-2">
                    {zentro.last4 ? `Visa •••• ${zentro.last4}` : "session stored"}
                    {zentro.lastError ? <Pill tone="stamp">error</Pill> : zentro.lastOkAt ? <Pill tone="verify">ok</Pill> : null}
                  </span>
                ) : (
                  <Link href="/admin" className="text-stamp font-sans underline underline-offset-4">
                    not connected · set up in /admin
                  </Link>
                )
              }
            />
            {zentro.lastError ? <p className="mt-1 font-mono text-[11px] text-stamp break-words">{zentro.lastError}</p> : null}
            <Row label="Operator" value={<span className="font-sans">{operatorName}</span>} />
          </div>
        </Panel>
      </aside>
    </div>
  );
}

const GROUP_HINT: Record<string, string> = {
  funded: "your tap",
  executing: "evidence being collected",
  funding: "card being credited",
  queued: "to fund",
};

/* ---------------- one delivery + runbook ---------------- */

function DeliveryCard({ d, expanded, onToggle, zentro, operatorName }: { d: OpsDelivery; expanded: boolean; onToggle: () => void; zentro: OpsZentro; operatorName: string }) {
  const { delivery, vault, cause } = d;
  return (
    <Panel as="article" className={cx(expanded && "outline-2 outline-ink")}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full text-left grid grid-cols-[90px_1fr_auto] sm:grid-cols-[90px_1fr_auto_auto] items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-stamp rounded-lg">
        <span className="font-mono text-[13px] tracking-wide">{receiptNo(delivery.ordinal)}</span>
        <span className="min-w-0">
          <span className="block text-[14px] truncate">
            {vault.name} <span className="text-muted">→</span> {cause.title}
          </span>
          <span className="block font-mono text-[11px] text-muted" suppressHydrationWarning>
            queued {timeAgo(delivery.queuedAt)}
            {delivery.fundedAt ? ` · funded ${timeAgo(delivery.fundedAt)}` : ""}
            {delivery.cardTxAt ? ` · paid ${timeAgo(delivery.cardTxAt)}` : ""}
          </span>
        </span>
        <span className="font-mono text-[15px] tabular-nums">{usdCents(delivery.amountUsdc)}</span>
        <span className="hidden sm:flex items-center gap-2">
          <RailPill rail={delivery.rail} />
          <span className="font-mono text-[11px] text-muted">{expanded ? "close" : "open"}</span>
        </span>
      </button>
      {expanded ? (
        <div className="hairline-t px-4 py-4">
          <div className="mb-4">
            <AllocationChips allocations={d.allocations} total={delivery.amountUsdc} />
          </div>
          {delivery.rail === "onchain" ? <OnchainRunbook d={d} /> : <CardRunbook d={d} zentro={zentro} operatorName={operatorName} />}
        </div>
      ) : null}
    </Panel>
  );
}

function StepHead({ n, title, done, active }: { n: number; title: string; done: boolean; active: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={cx("inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px]", done ? "bg-verify text-paper" : active ? "bg-ink text-paper" : "hairline text-muted")}>{done ? <CheckGlyph /> : n}</span>
      <h3 className={cx("font-mono text-[12px] uppercase tracking-[0.18em]", done || active ? "text-ink" : "text-muted")}>{title}</h3>
    </div>
  );
}

function Cell({ label, children, className, wide }: { label: ReactNode; children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cx("hairline rounded-sm bg-paper-2 px-3 py-2", wide && "sm:col-span-2", className)}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted flex items-center justify-between gap-2">{label}</div>
      <div className="mt-0.5 truncate">{children}</div>
    </div>
  );
}

/** Ticks once a second; "expired" past `until`. */
function Countdown({ until }: { until: Date | string }) {
  const target = new Date(until).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.floor((target - now) / 1000);
  if (left <= 0)
    return (
      <span className="text-stamp" suppressHydrationWarning>
        expired {timeAgo(target)}
      </span>
    );
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className={cx(left < 300 && "text-stamp")} suppressHydrationWarning>
      {m}:{String(s).padStart(2, "0")} left
    </span>
  );
}

/** One POST that advances the delivery, then refreshes the desk. */
function useAction(path: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    setDetail(null);
    const r = await api<{ detail?: string } | Delivery>(path, { method: "POST", json: {} });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if ("detail" in r.data && typeof r.data.detail === "string") setDetail(r.data.detail);
    router.refresh();
  }
  return { run, busy, error, detail };
}

/** Stranded funding (failed/reversed after the USDC left the treasury) came back: cite the refund so the ledger releases it. */
function RecoverForm({ d }: { d: OpsDelivery }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const txSig = String(new FormData(e.currentTarget).get("txSig") ?? "").trim();
    const r = await api<{ delivery: Delivery }>(`/api/deliveries/${d.delivery.id}/recover`, { json: { txSig } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="pb-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <Field label="Funds returned to treasury — tx signature" hint={`Must credit ${d.vault.name}'s treasury at least ${usdCents(d.delivery.amountUsdc)} USDC; checked on-chain.`}>
        <Input name="txSig" className="font-mono" required />
      </Field>
      <Button size="sm" type="submit" disabled={busy}>
        {busy ? "Verifying…" : "Record recovery"}
      </Button>
      {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
    </form>
  );
}

/* ---------------- onchain: one transfer ---------------- */

function FundStep({ d, to, toLabel, n, title, body }: { d: OpsDelivery; to: string | null; toLabel: string; n: number; title: string; body: string }) {
  const sig = d.delivery.fundingTxSig;
  const done = !!sig;
  const fund = useAction(`/api/deliveries/${d.delivery.id}/fund`);
  return (
    <section className="py-4 rule-dashed">
      <StepHead n={n} title={title} done={done} active={!done} />
      <div className="mt-3 pl-9 flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">{body}</p>
        <div className="grid gap-2 sm:grid-cols-2 font-mono text-[12px]">
          <Cell label="From · treasury">
            <ExternalLink href={solscanAddr(d.vault.treasuryAddress)}>{short(d.vault.treasuryAddress, 8, 8)}</ExternalLink>
          </Cell>
          <Cell label={`To · ${toLabel}`}>{to ? <ExternalLink href={solscanAddr(to)}>{short(to, 8, 8)}</ExternalLink> : <span className="text-stamp">not configured</span>}</Cell>
        </div>
        {done ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Pill tone="verify">
              <CheckGlyph /> funded
            </Pill>
            <ExternalLink href={solscanTx(sig)} className="font-mono text-[12px]">
              {short(sig, 8, 8)}
            </ExternalLink>
            {d.delivery.fundedAt ? <span className="font-mono text-[11px] text-muted" suppressHydrationWarning>{dateTime(d.delivery.fundedAt)}</span> : null}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={fund.run} disabled={fund.busy || !to}>
              {fund.busy ? "Sending…" : `Send ${usdCents(d.delivery.amountUsdc)} USDC`}
            </Button>
            {!to ? <span className="text-[12px] text-muted">Set the destination in .env first.</span> : null}
          </div>
        )}
        {fund.error ? <Notice>{fund.error}</Notice> : null}
      </div>
    </section>
  );
}

function OnchainRunbook({ d }: { d: OpsDelivery }) {
  const { delivery, cause } = d;
  const funded = !!delivery.fundingTxSig;
  return (
    <div className="flex flex-col">
      <FundStep d={d} n={1} title="Send USDC to cause" to={cause.onchainAddress} toLabel="cause address" body="Single on-chain transfer from the treasury to the cause's USDC address. The transfer signature is the rail reference." />
      <ArtifactsStep d={d} n={2} active={funded} optional />
      <FinalizeStep d={d} n={3} active={funded} defaults={{ railRef: delivery.fundingTxSig ?? "", fiatCurrency: "USD", fxRate: 1, amountFiat: delivery.amountUsdc, platformFeeFiat: null, notes: "USDC transfer to cause treasury." }} />
    </div>
  );
}

/* ---------------- operator card: invoice → credit → tap → reconcile ---------------- */

function CardRunbook({ d, zentro, operatorName }: { d: OpsDelivery; zentro: OpsZentro; operatorName: string }) {
  const { delivery, vault, cause } = d;
  const s = delivery.status;
  const displayName = `Fee Router — ${vault.name} community`;
  const [manual, setManual] = useState(false);
  const pastFunding = s === "funded" || s === "executing";
  return (
    <div className="flex flex-col">
      <TopUpStep d={d} zentro={zentro} />
      {s === "funding" ? <BridgeStep d={d} /> : null}
      {pastFunding ? <TapStep d={d} displayName={displayName} /> : null}
      {s === "executing" ? <HarvestStep d={d} /> : null}
      {pastFunding ? (
        <section className="py-4">
          <button type="button" onClick={() => setManual((m) => !m)} className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted underline underline-offset-4 hover:text-ink">
            {manual ? "Hide manual fallback" : "Manual fallback: upload evidence and finalize by hand"}
          </button>
          {manual ? (
            <div className="mt-2">
              <ArtifactsStep d={d} n={4} active />
              <FinalizeStep d={d} n={5} active defaults={{ railRef: delivery.railRef ?? `Visa •••• ${zentro.last4 ?? "____"} · `, fiatCurrency: "USD", fxRate: 1, amountFiat: delivery.amountUsdc, platformFeeFiat: null, notes: `Donated on ${PLATFORM_LABEL[cause.platform]} as "${displayName}" by ${operatorName}. Card statement reconciled by hand.` }} />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function TopUpStep({ d, zentro }: { d: OpsDelivery; zentro: OpsZentro }) {
  const { delivery } = d;
  const done = delivery.status !== "queued";
  const ready = zentro.sessionStored || zentro.canRelogin;
  const tooSmall = delivery.amountUsdc < ZENTRO_MIN_USD;
  const fund = useAction(`/api/deliveries/${d.delivery.id}/fund`);
  return (
    <section className="py-4 rule-dashed">
      <StepHead n={1} title="Top up the card" done={done} active={!done} />
      <div className="mt-3 pl-9 flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">One click: a Zentro top-up invoice is created and the treasury sends exactly what it asks for. The card credits within a few minutes.</p>
        <div className="grid gap-2 sm:grid-cols-2 font-mono text-[12px]">
          <Cell label="From · treasury">
            <ExternalLink href={solscanAddr(d.vault.treasuryAddress)}>{short(d.vault.treasuryAddress, 8, 8)}</ExternalLink>
          </Cell>
          <Cell label="To · Zentro invoice">{delivery.bridgeDepositAddress ? <ExternalLink href={solscanAddr(delivery.bridgeDepositAddress)}>{short(delivery.bridgeDepositAddress, 8, 8)}</ExternalLink> : <span className="text-muted">one-time address, created on send</span>}</Cell>
        </div>
        {done ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Pill tone="verify">
              <CheckGlyph /> sent
            </Pill>
            {delivery.fundingTxSig ? (
              <ExternalLink href={solscanTx(delivery.fundingTxSig)} className="font-mono text-[12px]">
                {short(delivery.fundingTxSig, 8, 8)}
              </ExternalLink>
            ) : null}
            {delivery.bridgeAmountUsdc ? <span className="font-mono text-[11px] text-muted">{delivery.bridgeAmountUsdc.toFixed(2)} USDC</span> : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={fund.run} disabled={fund.busy || !ready || tooSmall}>
              {fund.busy ? "Creating invoice and sending…" : `Top up ${usdCents(delivery.amountUsdc)}`}
            </Button>
            {!ready ? (
              <span className="text-[12px] text-stamp">
                Zentro not connected.{" "}
                <Link href="/admin" className="underline underline-offset-4">
                  Import a session
                </Link>
                .
              </span>
            ) : tooSmall ? (
              <span className="text-[12px] text-stamp">Zentro minimum top-up is {usd(ZENTRO_MIN_USD)}.</span>
            ) : null}
          </div>
        )}
        {delivery.bridgeStatus === "unfunded" && delivery.status === "queued" ? <Notice>Invoice {delivery.bridgeId} was created but the USDC transfer failed. Sending again creates a fresh invoice.</Notice> : null}
        {fund.error ? <Notice>{fund.error}</Notice> : null}
      </div>
    </section>
  );
}

function BridgeStep({ d }: { d: OpsDelivery }) {
  const { delivery } = d;
  const check = useAction(`/api/deliveries/${delivery.id}/bridge-check`);
  return (
    <section className="py-4 rule-dashed">
      <StepHead n={2} title="Card being credited" done={false} active />
      <div className="mt-3 pl-9 flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">Zentro bridges the USDC onto the card. The worker polls every minute; you will get an email when it lands.</p>
        <div className="grid gap-2 sm:grid-cols-2 font-mono text-[12px]">
          <Cell label={<>Deposit address {delivery.bridgeDepositAddress ? <CopyButton value={delivery.bridgeDepositAddress} /> : null}</>} wide>
            {delivery.bridgeDepositAddress ? <ExternalLink href={solscanAddr(delivery.bridgeDepositAddress)}>{delivery.bridgeDepositAddress}</ExternalLink> : "—"}
          </Cell>
          <Cell label="Exact amount sent">{delivery.bridgeAmountUsdc != null ? `${delivery.bridgeAmountUsdc.toFixed(2)} USDC` : "—"}</Cell>
          <Cell label="Invoice">{delivery.bridgeExpiresAt ? <Countdown until={delivery.bridgeExpiresAt} /> : "—"}</Cell>
          <Cell label="Bridge status">
            <span className="inline-flex items-center gap-2">
              <Pill tone={delivery.bridgeStatus && /complet/i.test(delivery.bridgeStatus) ? "verify" : "muted"}>{delivery.bridgeStatus ?? "waiting"}</Pill>
              <span className="text-muted">{delivery.bridgeId}</span>
            </span>
          </Cell>
          <Cell label="Funding tx">{delivery.fundingTxSig ? <ExternalLink href={solscanTx(delivery.fundingTxSig)}>{short(delivery.fundingTxSig, 8, 8)}</ExternalLink> : "—"}</Cell>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={check.run} disabled={check.busy}>
            {check.busy ? "Checking…" : "Check now"}
          </Button>
          {check.detail ? <span className="font-mono text-[12px] text-muted">{check.detail}</span> : null}
        </div>
        {check.error ? <Notice>{check.error}</Notice> : null}
      </div>
    </section>
  );
}

function TapStep({ d, displayName }: { d: OpsDelivery; displayName: string }) {
  const { delivery, cause } = d;
  const done = delivery.status === "executing";
  const reconcile = useAction(`/api/deliveries/${delivery.id}/reconcile`);
  return (
    <section className="py-4 rule-dashed">
      <StepHead n={2} title="Your tap" done={done} active={!done} />
      <div className={cx("mt-3 pl-9", !done && "sm:pl-0")}>
        {done ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Pill tone="verify">
              <CheckGlyph /> purchase found
            </Pill>
            <span className="font-mono text-[12px]">{delivery.cardTxMerchant}</span>
            {delivery.cardTxAt ? <span className="font-mono text-[11px] text-muted" suppressHydrationWarning>{dateTime(delivery.cardTxAt)}</span> : null}
          </div>
        ) : (
          <div className="rounded-lg bg-ink text-paper p-5 sm:p-6">
            <Eyebrow className="text-paper/60">The one thing only you can do</Eyebrow>
            <p className="mt-2 font-display text-[28px] sm:text-[34px] leading-[1] tracking-tight">
              Donate {usdCents(delivery.amountUsdc)} on {PLATFORM_LABEL[cause.platform]} with the Fee Router card.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-3 font-mono text-[12px]">
              <div className="rounded-sm bg-paper/10 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.18em] text-paper/60">Exact amount</div>
                <div className="mt-0.5 text-[18px] tabular-nums">{usdCents(delivery.amountUsdc)}</div>
              </div>
              <div className="rounded-sm bg-paper/10 px-3 py-2 sm:col-span-2">
                <div className="text-[10px] uppercase tracking-[0.18em] text-paper/60 flex items-center justify-between">
                  Display name <CopyButton value={displayName} />
                </div>
                <div className="mt-0.5 truncate font-sans text-[14px]">{displayName}</div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <a href={cause.url} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-sm bg-paper px-5 text-[14px] font-medium text-ink hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp">
                Open {PLATFORM_LABEL[cause.platform]} ↗
              </a>
              <span className="font-mono text-[11px] text-paper/60 truncate max-w-[40ch]">{cause.url}</span>
            </div>
            <p className="mt-5 text-[13px] text-paper/70" suppressHydrationWarning>We detect the purchase on the card automatically and attach the statement line and the confirmation email. {delivery.notifiedAt ? `Emailed to you ${timeAgo(delivery.notifiedAt)}.` : "Notification email not sent yet."}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button size="sm" variant="paper" onClick={reconcile.run} disabled={reconcile.busy}>
                {reconcile.busy ? "Checking the card…" : "I paid — check now"}
              </Button>
              {reconcile.detail ? <span className="font-mono text-[12px] text-paper/70">{reconcile.detail}</span> : null}
            </div>
            {reconcile.error ? (
              <Notice className="mt-3 bg-paper text-stamp">
                {reconcile.error}
              </Notice>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function HarvestStep({ d }: { d: OpsDelivery }) {
  const { delivery } = d;
  const reconcile = useAction(`/api/deliveries/${delivery.id}/reconcile`);
  return (
    <section className="py-4 rule-dashed">
      <StepHead n={3} title="Evidence being collected" done={false} active />
      <div className="mt-3 pl-9 flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">
          The card statement line for <span className="font-mono">{delivery.cardTxMerchant}</span> is attached; the platform confirmation email is being looked up and the receipt sealed. The worker retries every minute.
        </p>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={reconcile.run} disabled={reconcile.busy}>
            {reconcile.busy ? "Working…" : "Try again now"}
          </Button>
          {reconcile.detail ? <span className="font-mono text-[12px] text-muted">{reconcile.detail}</span> : null}
        </div>
        {reconcile.error ? <Notice>{reconcile.error}</Notice> : null}
      </div>
    </section>
  );
}

function ArtifactsStep({ d, n, active, optional }: { d: OpsDelivery; n: number; active: boolean; optional?: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<{ label: string; sha256: string }[]>([]);

  async function pick(f: File | null) {
    setFile(f);
    setHash(null);
    setError(null);
    if (f) setHash(await sha256Hex(f));
  }

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || !hash) return;
    setBusy(true);
    setError(null);
    const el = e.currentTarget;
    const form = new FormData(el);
    const body = new FormData();
    body.set("file", file);
    body.set("kind", String(form.get("kind")));
    body.set("label", String(form.get("label") ?? "").trim() || file.name.slice(0, 120));
    body.set("sha256", hash);
    const r = await api<ReceiptArtifact>(`/api/deliveries/${d.delivery.id}/artifacts`, { method: "POST", body });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setUploaded((xs) => [...xs, { label: r.data.label, sha256: r.data.sha256 }]);
    setFile(null);
    setHash(null);
    el.reset();
    router.refresh();
  }

  return (
    <section className="py-4 rule-dashed">
      <StepHead n={n} title={`Upload evidence${optional ? " (optional)" : ""}`} done={uploaded.length > 0} active={active} />
      <div className="mt-3 pl-9 flex flex-col gap-3">
        <p className="text-[13px] text-ink-2">Screenshots, confirmation email, card statement line. The sha256 is computed here before upload and printed on the receipt.</p>
        {uploaded.length ? (
          <ul className="flex flex-col gap-1 font-mono text-[12px]">
            {uploaded.map((a) => (
              <li key={a.sha256} className="flex items-center gap-2">
                <CheckGlyph className="text-verify" /> {a.label} <span className="text-muted">{short(a.sha256, 10, 8)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={upload} className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="File" className="sm:col-span-2">
            <input type="file" name="file" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="block w-full text-[13px] file:mr-3 file:h-8 file:rounded-sm file:border-0 file:bg-ink file:px-3 file:text-[12px] file:text-paper hover:file:bg-ink-2" />
          </Field>
          <Field label="Label">
            <Input name="label" defaultValue="" placeholder={file?.name ?? "GoFundMe confirmation"} />
          </Field>
          <Field label="Kind">
            <Select name="kind" defaultValue="screenshot">
              {ARTIFACT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          {file ? (
            <div className="sm:col-span-2">
              <AddressBlock label={`sha256 · ${(file.size / 1024).toFixed(0)} KB`} value={hash ?? "hashing…"} />
            </div>
          ) : null}
          {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
          <div className="sm:col-span-2 flex justify-end">
            <Button size="sm" type="submit" disabled={busy || !file || !hash}>
              {busy ? "Uploading…" : "Attach"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

interface FinalizeDefaults {
  railRef: string;
  fiatCurrency: string;
  fxRate: number;
  amountFiat: number;
  platformFeeFiat: number | null;
  notes: string;
}

function FinalizeStep({ d, n, active, defaults }: { d: OpsDelivery; n: number; active: boolean; defaults: FinalizeDefaults }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Delivery | null>(null);

  async function finalize(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const num = (k: string) => {
      const v = String(f.get(k) ?? "").trim();
      return v === "" ? undefined : Number(v);
    };
    const r = await api<{ delivery: Delivery }>(`/api/deliveries/${d.delivery.id}/finalize`, {
      json: { railRef: String(f.get("railRef") ?? "").trim() || undefined, amountFiat: num("amountFiat"), fiatCurrency: String(f.get("fiatCurrency") ?? "USD").trim().toUpperCase(), fxRate: num("fxRate"), platformFeeFiat: num("platformFeeFiat"), notes: String(f.get("notes") ?? "").trim() || undefined },
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r.data.delivery);
    router.refresh();
  }

  if (result) {
    return (
      <section className="py-4">
        <StepHead n={n} title="Finalized" done active={false} />
        <div className="mt-3 pl-9 flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <Stamp animate className="text-[20px] text-verify! border-verify!">
              <CheckGlyph /> Delivered
            </Stamp>
            <Link href={`/r/${result.id}`} className="font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
              Open receipt {receiptNo(result.ordinal)}
            </Link>
          </div>
          <div className="font-mono text-[12px]">
            <Row label="Receipt hash" value={result.receiptHash ? short(result.receiptHash, 12, 8) : "—"} />
            <Row label="Anchor tx" value={result.anchorTxSig ? <ExternalLink href={solscanTx(result.anchorTxSig)}>{short(result.anchorTxSig, 8, 8)}</ExternalLink> : <span className="text-muted">not anchored (signer not configured)</span>} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-4">
      <StepHead n={n} title="Finalize" done={false} active={active} />
      <form onSubmit={finalize} className="mt-3 pl-9 grid gap-3 sm:grid-cols-2">
        <Field label="Rail reference" className="sm:col-span-2" hint={d.delivery.rail === "onchain" ? "Transfer signature." : "Card last4 and authorisation code from the statement."}>
          <Input name="railRef" defaultValue={defaults.railRef} className="font-mono" required />
        </Field>
        <Field label="Amount (fiat)">
          <Input name="amountFiat" type="number" step="0.01" min={0} defaultValue={defaults.amountFiat} required />
        </Field>
        <Field label="Currency">
          <Input name="fiatCurrency" defaultValue={defaults.fiatCurrency} maxLength={3} className="font-mono uppercase" required />
        </Field>
        <Field label="FX rate (USDC → fiat)">
          <Input name="fxRate" type="number" step="0.0001" min={0} defaultValue={defaults.fxRate} required />
        </Field>
        <Field label="Platform fee (fiat)">
          <Input name="platformFeeFiat" type="number" step="0.01" min={0} defaultValue={defaults.platformFeeFiat ?? ""} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea name="notes" defaultValue={defaults.notes} />
        </Field>
        {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
        <div className="sm:col-span-2 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">Computes the receipt hash and anchors it on-chain when a signer is configured.</span>
          <Button size="sm" variant="stamp" type="submit" disabled={busy || !active}>
            {busy ? "Finalizing…" : "Finalize delivery"}
          </Button>
        </div>
      </form>
    </section>
  );
}

/* ---------------- queue a delivery ---------------- */

function QueueForm({ vaults }: { vaults: OpsVault[] }) {
  const router = useRouter();
  const [vaultId, setVaultId] = useState(vaults[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<Delivery | null>(null);
  const v = vaults.find((x) => x.id === vaultId) ?? null;
  // Mirrors the ledger's deliverable: delivered, in-flight and stranded deliveries all hold their allocations.
  const undelivered = v ? Math.max(0, v.feesUsd * (v.donateBps / 10000) - v.deliveredUsd - v.pendingUsd - v.strandedUsd) : 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setQueued(null);
    const amount = Number(new FormData(e.currentTarget).get("amountUsdc"));
    const r = await api<{ delivery: Delivery }>("/api/deliveries", { json: { vaultId, amountUsdc: amount } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setQueued(r.data.delivery);
    router.refresh();
  }

  return (
    <Panel className="p-5" as="section">
      <Eyebrow>Queue a delivery</Eyebrow>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <Field label="Vault">
          <Select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
            {vaults.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        {v ? (
          <div className="font-mono text-[12px]">
            <Row label="Threshold" value={usd(v.deliveryThresholdUsd)} />
            <Row label="Undelivered" value={<span className={cx(undelivered >= v.deliveryThresholdUsd && "text-verify")}>{usdCents(undelivered)}</span>} />
            <Row label="In flight" value={usdCents(v.pendingUsd)} />
            {v.strandedUsd > 0 ? <Row label="Stranded" value={<span className="text-stamp">{usdCents(v.strandedUsd)}</span>} /> : null}
          </div>
        ) : null}
        <Field label="Amount (USDC)" hint={v && undelivered < v.deliveryThresholdUsd ? `Below threshold; ${usdCents(v.deliveryThresholdUsd - undelivered)} short.` : "Allocations split pro-rata by undelivered fees per token."}>
          <Input key={vaultId} name="amountUsdc" type="number" step="0.01" min={1} defaultValue={v ? Math.floor(undelivered * 100) / 100 : ""} required />
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        {queued ? (
          <Notice tone="verify">
            Queued {receiptNo(queued.ordinal)} · {usdCents(queued.amountUsdc)}
          </Notice>
        ) : null}
        <Button size="sm" type="submit" disabled={busy || !vaultId}>
          {busy ? "Queueing…" : "Queue delivery"}
        </Button>
      </form>
    </Panel>
  );
}
