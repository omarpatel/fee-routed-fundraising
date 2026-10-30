"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useFeeRouterUser } from "@/components/auth";
import { Button, cx, Eyebrow, Panel, Pill, Row, Stamp, StatusPill } from "@/components/ui";
import { CheckGlyph, PLATFORM_LABEL } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import type { Cause, Launch, Vault } from "@/lib/db/schema";
import { short, solscanAddr, solscanTx } from "@/lib/format";
import { api } from "./api";
import { Field, Input, Notice, Select, Textarea } from "./forms";
import { ImageUpload, type UploadedImage } from "./ImageUpload";

export interface LaunchFormProps {
  causes: Pick<Cause, "id" | "slug" | "title" | "platform">[];
  vaults: Pick<Vault, "id" | "slug" | "name" | "causeId">[];
}

interface LaunchResult {
  launchId: string;
  mint: string;
  sigs: string[];
  tokenId: string;
  routeAddress: string;
  vaultSlug: string;
  launchpadUrl: string;
}
interface LaunchStatus {
  id: string;
  status: Launch["status"];
  meta: { routeAddress?: string; mint?: string; metadataUrl?: string; signatures?: string[]; fundingSig?: string };
  error: string | null;
  tokenId: string | null;
  vaultSlug: string;
}
interface WalletSummary {
  address: string;
  balances: { sol: number } | null;
  balancesError: string | null;
}

type Phase = { kind: "idle" } | { kind: "launching" } | { kind: "live"; result: LaunchResult } | { kind: "not_configured"; error: string } | { kind: "error"; error: string };

/** Mirrors `PUMP_CREATE_RESERVE_SOL` + `LAUNCH_WALLET_MARGIN_SOL` on the server. */
const CREATE_RESERVE_SOL = 0.03;
const WALLET_MARGIN_SOL = 0.005;
const DEFAULT_DEV_BUY_SOL = 0.1;
const NOT_CONFIGURED: Record<string, true> = { "KMS not configured": true, "RPC not configured": true };

export function LaunchForm({ causes, vaults }: LaunchFormProps) {
  const { user, ready, login, configured } = useFeeRouterUser();
  // Start on a fundraiser the user can actually launch for (one of their vaults), not simply the newest one.
  const [causeId, setCauseIdRaw] = useState(vaults[0]?.causeId ?? causes[0]?.id ?? "");
  const [vaultId, setVaultId] = useState(vaults[0]?.id ?? "");
  const [devBuy, setDevBuy] = useState(String(DEFAULT_DEV_BUY_SOL));
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<LaunchStatus | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);

  const causeVaults = vaults.filter((v) => v.causeId === causeId);
  const setCauseId = (id: string) => {
    setCauseIdRaw(id);
    setVaultId(vaults.find((v) => v.causeId === id)?.id ?? "");
  };

  // Wallet SOL: the launch is paid from the custodial wallet, so the form says up front whether it can go.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<WalletSummary>("/api/wallet").then((r) => {
      if (alive && r.ok) setWallet(r.data);
    });
    return () => {
      alive = false;
    };
  }, [user, phase.kind]);

  // Re-read the launch row once it is live so the panel reflects the ledger, not just the response.
  useEffect(() => {
    if (phase.kind !== "live") return;
    let alive = true;
    api<LaunchStatus>(`/api/launch/${phase.result.launchId}`).then((r) => {
      if (alive && r.ok) setStatus(r.data);
    });
    return () => {
      alive = false;
    };
  }, [phase]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!vaultId || !image) return;
    const f = new FormData(e.currentTarget);
    setStatus(null);
    setPhase({ kind: "launching" });
    const website = String(f.get("website") ?? "").trim();
    const twitter = String(f.get("twitter") ?? "").trim();
    const r = await api<LaunchResult>("/api/launch", {
      json: {
        vaultId,
        name: String(f.get("name") ?? "").trim(),
        symbol: String(f.get("symbol") ?? "").trim().toUpperCase().replace(/^\$/, ""),
        description: String(f.get("description") ?? "").trim(),
        imageUrl: image.url,
        devBuySol: devBuySol,
        website: website || undefined,
        twitter: twitter || undefined,
      },
    });
    if (!r.ok) {
      setPhase(NOT_CONFIGURED[r.error] ? { kind: "not_configured", error: r.error } : { kind: "error", error: r.error });
      return;
    }
    setPhase({ kind: "live", result: r.data });
  }

  const devBuySol = Math.max(0, Number(devBuy) || 0);
  const needSol = Math.round((devBuySol + CREATE_RESERVE_SOL + WALLET_MARGIN_SOL) * 1000) / 1000;

  const busy = phase.kind === "launching";
  const sol = wallet?.balances?.sol ?? null;
  const underfunded = sol !== null && sol < needSol;
  const sigs = status?.meta.signatures ?? (phase.kind === "live" ? phase.result.sigs : []);
  const mint = status?.meta.mint ?? (phase.kind === "live" ? phase.result.mint : undefined);
  const routeAddress = status?.meta.routeAddress ?? (phase.kind === "live" ? phase.result.routeAddress : undefined);
  const settled = status?.status ?? (phase.kind === "live" ? "launched" : undefined);

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
      <form onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        {ready && !user ? (
          <Notice tone="muted" className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 font-sans">
            <span>{configured ? "Sign in first. The launch is paid from and signed by your Fee Router wallet." : "Sign-in is not configured (GOOGLE_CLIENT_ID), so nothing can be launched here."}</span>
            {configured ? (
              <Button size="sm" type="button" onClick={() => login()}>
                Sign in
              </Button>
            ) : null}
          </Notice>
        ) : null}

        {user ? (
          <Notice tone={underfunded ? "stamp" : "muted"} className="sm:col-span-2 font-sans">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Wallet SOL: <span className="font-mono tabular-nums">{sol === null ? (wallet?.balancesError ?? "reading…") : sol.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span>
                {underfunded ? ` · ${needSol} SOL is needed for this launch` : ` · ${needSol} SOL covers this launch`}
              </span>
              <Link href="/dashboard" className="font-mono text-[11px] uppercase tracking-[0.12em] underline underline-offset-4">
                Wallet
              </Link>
            </div>
            {underfunded || sol === null ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span>Deposit SOL to</span>
                <span className="break-all font-mono tabular-nums select-all">{user.walletAddress}</span>
                <CopyButton value={user.walletAddress} />
              </div>
            ) : null}
          </Notice>
        ) : null}

        <Field label="Token name" required>
          <Input name="name" required minLength={2} maxLength={32} placeholder="Cure" />
        </Field>
        <Field label="Symbol" required>
          <Input name="symbol" required minLength={2} maxLength={10} placeholder="CURE" className="font-mono uppercase" />
        </Field>
        <Field label="Description" required className="sm:col-span-2">
          <Textarea name="description" required minLength={20} maxLength={600} placeholder="What the token is for and where its fees go." />
        </Field>
        <ImageUpload kind="token" value={image} onChange={setImage} label="Token image" required shape="square" className="sm:col-span-2" hint="Square PNG, JPG or WEBP. Stored as a 1024 px PNG and pinned to the token metadata." disabled={busy} />
        <Field label="Website" hint="Optional. Shown on pump.fun.">
          <Input name="website" type="url" placeholder="https://…" />
        </Field>
        <Field label="X / Twitter" hint="Optional. Handle or URL.">
          <Input name="twitter" maxLength={64} placeholder="@handle" />
        </Field>

        <Field label="Fundraiser" required hint={causes.length ? undefined : "No fundraisers yet."}>
          {causes.length ? (
            <Select value={causeId} onChange={(e) => setCauseId(e.target.value)}>
              {causes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} · {PLATFORM_LABEL[c.platform]}
                </option>
              ))}
            </Select>
          ) : (
            <Link href="/connect" className="inline-flex h-10 items-center font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
              Connect a fundraiser first →
            </Link>
          )}
        </Field>
        <Field label="Vault" required hint={causeVaults.length ? undefined : "This fundraiser has no vault yet."}>
          {causeVaults.length ? (
            <Select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
              {causeVaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          ) : (
            <Link href={`/connect?step=vault${causeId ? `&cause=${causeId}` : ""}`} className="inline-flex h-10 items-center font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
              Create a vault →
            </Link>
          )}
        </Field>

        <Field label="Dev buy (SOL)" hint="Bought on the curve by the route wallet at creation. 0 creates without a buy.">
          <Input name="devBuySol" type="number" min={0} max={50} step={0.01} value={devBuy} onChange={(e) => setDevBuy(e.target.value)} />
        </Field>
        <Field label="Total SOL needed" hint={`${devBuySol} SOL dev buy + ${CREATE_RESERVE_SOL} SOL rent and fees + ${WALLET_MARGIN_SOL} SOL transfer margin. Sent from your Fee Router wallet to the route address.`}>
          <div className="flex h-10 items-center font-mono text-[14px] tabular-nums">{needSol} SOL</div>
        </Field>

        <Notice tone="muted" className="sm:col-span-2 font-sans">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Creator wallet</div>
          <p className="mt-1 text-[13px] text-ink-2">
            Fee Router mints a fresh route address for this token and that address signs the pump.fun create transaction as the token&apos;s creator. 100% of creator fees accrue to it from the first trade and pump.fun cannot redirect them afterwards. The address prints here once the launch runs.
          </p>
          {routeAddress ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="break-all font-mono tabular-nums select-all">{routeAddress}</span>
              <CopyButton value={routeAddress} />
            </div>
          ) : null}
        </Notice>

        {phase.kind === "not_configured" ? (
          <Notice className="sm:col-span-2 font-sans">
            <div className="font-mono">{phase.error}</div>
            <p className="mt-1 text-ink-2">
              Launching needs <code className="font-mono">FEE_ROUTER_KMS_KEY</code> and <code className="font-mono">SOLANA_RPC_URL</code> in <code className="font-mono">.env</code>. Nothing was created.
            </p>
          </Notice>
        ) : phase.kind === "error" ? (
          <Notice className="sm:col-span-2">{phase.error}</Notice>
        ) : null}

        <div className="sm:col-span-2 flex items-center justify-between gap-3 pt-2">
          <span className="text-[12px] text-muted">All creator fees route to the vault. The route address is the creator.</span>
          <Button type="submit" size="lg" variant="stamp" disabled={busy || phase.kind === "live" || !vaultId || !user || underfunded || !image}>
            {busy ? "Launching…" : phase.kind === "live" ? "Launched" : "Launch on pump.fun"}
          </Button>
        </div>
      </form>

      <aside className="flex flex-col gap-4">
        <Panel className="p-5">
          <Eyebrow>Launch status</Eyebrow>
          {phase.kind === "idle" || phase.kind === "not_configured" ? (
            <p className="mt-2 text-[13px] text-muted">Nothing launched yet. The status of each step prints here.</p>
          ) : (
            <ol className="mt-3 flex flex-col">
              <Step done={phase.kind === "live"} active={busy} label="Fund the route wallet" detail={routeAddress ? short(routeAddress, 6, 6) : `${needSol} SOL from your Fee Router wallet`} failed={phase.kind === "error"} />
              <Step done={phase.kind === "live"} active={busy} label="Create on pump.fun" detail={sigs.length ? `${sigs.length} confirmed` : "metadata + create tx"} failed={phase.kind === "error"} />
              <Step done={settled === "launched"} active={busy} label="Token live" detail={settled} failed={settled === "failed" || phase.kind === "error"} />
            </ol>
          )}
          {phase.kind === "live" ? (
            <div className="mt-4 hairline-t pt-1">
              <Row label="Status" value={<StatusPill status={settled ?? "launched"} />} />
              {mint ? (
                <Row
                  label="Mint"
                  value={
                    <a href={solscanAddr(mint)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                      {short(mint, 6, 6)}
                    </a>
                  }
                />
              ) : null}
              {routeAddress ? <Row label="Creator / route" value={short(routeAddress, 6, 6)} /> : null}
              {sigs.map((s, i) => (
                <Row
                  key={s}
                  label={`Tx ${i + 1}`}
                  value={
                    <a href={solscanTx(s)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                      {short(s, 6, 6)}
                    </a>
                  }
                />
              ))}
              {status?.error ? <Notice className="mt-3">{status.error}</Notice> : null}
              {settled === "launched" ? (
                <div className="mt-4 flex items-center justify-between">
                  <Stamp animate className="text-[18px] text-verify! border-verify!">
                    <CheckGlyph /> Live
                  </Stamp>
                  <a href={phase.result.launchpadUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
                    pump.fun
                  </a>
                  <Link href={`/v/${status?.vaultSlug || phase.result.vaultSlug}#attribution`} className="font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
                    Open vault
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>
        <Panel className="p-5">
          <Eyebrow>What happens</Eyebrow>
          <ol className="mt-2 flex flex-col gap-2 text-[13px] text-ink-2 list-decimal pl-4">
            <li>Fee Router mints a route address for the token and your Fee Router wallet sends it the dev buy plus rent.</li>
            <li>The route address signs the pump.fun create transaction as the creator. Nothing to approve in a browser extension.</li>
            <li>The token goes live on pump.fun. Creator fees accrue to the route address from the first trade and are claimed and swept to the vault by Fee Router.</li>
          </ol>
          <div className="mt-3 flex items-center gap-2">
            <Pill tone="ink">via fee router</Pill>
            <span className="text-[12px] text-muted">Tokens launched here show the badge on their vault.</span>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function Step({ done, active, label, detail, failed }: { done?: boolean; active?: boolean; label: string; detail?: string; failed?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2 rule-dashed">
      <span className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px]", failed ? "bg-stamp text-paper" : done ? "bg-verify text-paper" : active ? "bg-ink text-paper animate-pulse" : "hairline text-muted")}>{done && !failed ? <CheckGlyph /> : failed ? "×" : "·"}</span>
      <span className={cx("text-[13px]", done || active ? "text-ink" : "text-muted")}>{label}</span>
      {detail ? <span className="ml-auto font-mono text-[11px] text-muted tabular-nums">{detail}</span> : null}
    </li>
  );
}
