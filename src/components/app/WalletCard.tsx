"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import { Button, Eyebrow, Pill, Row } from "@/components/ui";
import type { WalletTransfer } from "@/lib/db/schema";
import { dateTime, rawToUi, short, solscanAddr, solscanTx } from "@/lib/format";
import { api } from "./api";
import { Field, Input, Notice, Select } from "./forms";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TokenBalance {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}
interface WalletData {
  address: string;
  balances: { sol: number; usdc: number; tokens: TokenBalance[] } | null;
  balancesError: string | null;
  transfers: WalletTransfer[];
}

type Asset = { mint: "SOL"; label: "SOL"; decimals: 9; available: number } | { mint: string; label: string; decimals: number; available: number };

const TRANSFER_TONE: Record<WalletTransfer["status"], "muted" | "ink" | "verify" | "stamp"> = { pending: "muted", sent: "ink", confirmed: "verify", failed: "stamp" };

function amountFmt(n: number, decimals: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, n >= 1 ? 4 : 6) });
}

/**
 * Custodial wallet on the dashboard: deposit (address + QR), balances, send, and the outflow ledger.
 * Everything comes from GET /api/wallet; the QR is rendered server-side and handed in as SVG.
 */
export function WalletCard({ address, qrSvg }: { address: string; qrSvg: string }) {
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(
    () =>
      api<WalletData>("/api/wallet").then((r) => {
        if (r.ok) {
          setData(r.data);
          setError(null);
        } else setError(r.error);
      }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const b = data?.balances ?? null;
  const assets: Asset[] = b
    ? [
        { mint: "SOL", label: "SOL", decimals: 9, available: b.sol },
        ...b.tokens.map((t) => ({ mint: t.mint, label: t.mint === USDC_MINT ? "USDC" : short(t.mint, 4, 4), decimals: t.decimals, available: t.uiAmount })),
      ]
    : [];
  const decimalsFor = (mint: string): number | null => (mint === SOL_MINT ? 9 : mint === USDC_MINT ? 6 : (b?.tokens.find((t) => t.mint === mint)?.decimals ?? null));

  return (
    <div className="flex flex-col gap-4">
      <section className="hairline rounded-lg bg-paper p-5">
        <Eyebrow>Wallet</Eyebrow>
        <div className="mt-3 flex items-start gap-4">
          <div className="shrink-0 rounded-sm hairline bg-paper p-1.5 [&>svg]:block [&>svg]:h-[112px] [&>svg]:w-[112px]" aria-label="Deposit QR code" role="img" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <div className="min-w-0 flex-1">
            <div className="break-all font-mono text-[13px] tabular-nums">{address}</div>
            <div className="mt-2 flex items-center gap-3">
              <CopyButton value={address} />
              <ExternalLink href={solscanAddr(address)} className="font-mono text-[11px] uppercase tracking-[0.12em]">
                Solscan
              </ExternalLink>
            </div>
            <p className="mt-2 text-[12px] text-muted">Send SOL or any SPL token to this address on Solana mainnet. Keys are held by Fee Router and encrypted at rest.</p>
          </div>
        </div>

        <div className="mt-4 hairline-t pt-1">
          {!data && !error ? (
            <Row label="Balance" value={<span className="text-muted">reading…</span>} />
          ) : error ? (
            <Row label="Balance" value={<span className="text-stamp font-sans">{error}</span>} />
          ) : !b ? (
            <>
              <Row label="Balance" value={<span className="text-stamp font-sans">{data!.balancesError}</span>} />
              <p className="pt-2 text-[12px] text-muted">
                Balances and sending need <code className="font-mono">SOLANA_RPC_URL</code>. Deposits still work.
              </p>
            </>
          ) : (
            <>
              <Row label="SOL" value={amountFmt(b.sol, 9)} />
              <Row label="USDC" value={<span className="text-usdc">{b.usdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>} />
              {b.tokens
                .filter((t) => t.mint !== USDC_MINT)
                .map((t) => (
                  <Row
                    key={t.mint}
                    label={
                      <a href={solscanAddr(t.mint)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-4">
                        {short(t.mint, 4, 4)}
                      </a>
                    }
                    value={amountFmt(t.uiAmount, t.decimals)}
                  />
                ))}
            </>
          )}
        </div>

        {b ? (
          <div className="mt-4">
            {sending ? (
              <SendForm assets={assets} refresh={load} onClose={() => setSending(false)} />
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setSending(true)} disabled={b.sol <= 0 && b.tokens.length === 0}>
                Send
              </Button>
            )}
          </div>
        ) : null}
      </section>

      <section className="hairline rounded-lg bg-paper p-5">
        <Eyebrow>Transfers</Eyebrow>
        {!data ? (
          <p className="mt-2 text-[13px] text-muted">reading…</p>
        ) : data.transfers.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">Nothing sent from this wallet yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {data.transfers.map((t) => {
              const decimals = decimalsFor(t.assetMint);
              const label = t.assetMint === SOL_MINT ? "SOL" : t.assetMint === USDC_MINT ? "USDC" : short(t.assetMint, 4, 4);
              return (
                <li key={t.id} className="flex flex-col gap-1 py-2.5 rule-dashed">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[13px] tabular-nums">
                      {decimals === null ? `${t.amountRaw} raw` : amountFmt(rawToUi(t.amountRaw, decimals), decimals)} {label}
                    </span>
                    <Pill tone={TRANSFER_TONE[t.status]}>{t.status}</Pill>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[12px] text-muted">
                    <span className="font-mono">to {short(t.toAddress, 4, 4)}</span>
                    <span>
                      {t.txSig ? (
                        <ExternalLink href={solscanTx(t.txSig)} className="font-mono">
                          {short(t.txSig, 4, 4)}
                        </ExternalLink>
                      ) : (
                        dateTime(t.createdAt)
                      )}
                    </span>
                  </div>
                  {t.error ? <div className="font-mono text-[12px] text-stamp break-words">{t.error}</div> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

type SendStep = { kind: "form" } | { kind: "confirm" } | { kind: "sending" } | { kind: "error"; error: string };

function SendForm({ assets, refresh, onClose }: { assets: Asset[]; refresh: () => Promise<void>; onClose: () => void }) {
  const [mint, setMint] = useState(assets[0]?.mint ?? "SOL");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [step, setStep] = useState<SendStep>({ kind: "form" });
  /** One key per withdraw intent: a retry after a lost response reuses it so the server returns the first transfer instead of sending again. */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const newIntent = () => setIdempotencyKey(crypto.randomUUID());
  const asset = assets.find((a) => a.mint === mint) ?? assets[0];

  function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStep({ kind: "confirm" });
  }

  async function send() {
    setStep({ kind: "sending" });
    const r = await api<WalletTransfer>("/api/wallet/withdraw", { json: { mint, amount: amount.trim(), to: to.trim(), idempotencyKey } });
    if (!r.ok) {
      // Keep the key: the transfer may have gone out even though the response did not arrive.
      setStep({ kind: "error", error: r.error });
      return;
    }
    await refresh();
    // The server settled this intent (sent or definitively failed); anything after is a new one.
    newIntent();
    if (r.data.status === "failed") {
      setStep({ kind: "error", error: r.data.error ?? "Transfer failed" });
      return;
    }
    onClose();
  }

  const busy = step.kind === "sending";

  return (
    <form onSubmit={review} className="grid gap-3 rounded-sm hairline bg-paper-2 p-3">
      <Eyebrow>Send</Eyebrow>
      {step.kind === "confirm" || step.kind === "sending" ? (
        <>
          <div className="font-sans text-[13px] text-ink-2">Confirm this transfer. It is signed by Fee Router and cannot be reversed once it lands.</div>
          <div className="hairline-t">
            <Row label="Amount" value={`${amount.trim()} ${asset?.label ?? mint}`} />
            <Row label="To" value={<span className="break-all">{to.trim()}</span>} />
            <Row label="Network fee" value="about 0.000005 SOL" />
          </div>
          <p className="text-[12px] text-muted">A 0.002 SOL reserve stays in the wallet for rent and fees. Sending a token to a fresh recipient also creates its token account (about 0.002 SOL).</p>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep({ kind: "form" })} disabled={busy}>
              Back
            </Button>
            <Button type="button" variant="stamp" size="sm" onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send now"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Asset" required>
            <Select
              value={mint}
              onChange={(e) => {
                setMint(e.target.value);
                newIntent();
              }}
            >
              {assets.map((a) => (
                <option key={a.mint} value={a.mint}>
                  {a.label} · {amountFmt(a.available, a.decimals)} available
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" required hint={asset ? `Up to ${asset.decimals} decimal places.` : undefined}>
            <Input
              name="amount"
              inputMode="decimal"
              required
              pattern="^\d+(\.\d+)?$"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                newIntent();
              }}
              placeholder="0.00"
              className="font-mono tabular-nums"
            />
          </Field>
          <Field label="To (Solana address)" required>
            <Input
              name="to"
              required
              minLength={32}
              maxLength={44}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                newIntent();
              }}
              placeholder="Recipient address"
              className="font-mono"
            />
          </Field>
          {step.kind === "error" ? <Notice>{step.error}</Notice> : null}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="ink" size="sm" disabled={!amount.trim() || !to.trim()}>
              Review
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
