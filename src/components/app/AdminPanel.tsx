"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Mono } from "@/components/ui";
import { ExternalLink } from "@/components/app";
import { short, solscanTx } from "@/lib/format";
import { api } from "./api";
import { Field, Input, Notice, Textarea } from "./forms";
import { ImageUpload, type UploadedImage } from "./ImageUpload";

/* Admin actions. Each button hits /api/admin/** and refreshes the server-rendered page around it. */

export function CreateTreasuryButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await api<{ address: string }>("/api/admin/protocol/treasury", { method: "POST", json: {} });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-3">
      <Button onClick={run} disabled={busy}>
        {busy ? "Creating…" : "Create treasury"}
      </Button>
      {error ? <Notice>{error}</Notice> : null}
    </div>
  );
}

export function RegisterHeliusButton({ disabled, reason }: { disabled?: boolean; reason?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "stamp" | "verify"; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    const r = await api<{ webhookId: string | null; addresses: number }>("/api/admin/helius/register", { method: "POST", json: {} });
    setBusy(false);
    if (!r.ok) return setMsg({ tone: "stamp", text: r.error });
    setMsg({ tone: "verify", text: `Webhook ${r.data.webhookId ?? "—"} watching ${r.data.addresses} address(es)` });
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" onClick={run} disabled={busy || disabled} title={reason}>
        {busy ? "Registering…" : "Register Helius webhook now"}
      </Button>
      {disabled && reason ? <span className="text-[12px] text-muted">{reason}</span> : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </div>
  );
}

interface LaunchResult {
  launchId: string;
  mint: string;
  creator: string;
  signatures: string[];
  commonsVaultSlug: string;
  launchpadUrl: string;
}

const DEFAULT_DEV_BUY_SOL = 0.5;

export function LaunchProtocolForm({ blocked }: { blocked: string[] }) {
  const router = useRouter();
  const [description, setDescription] = useState("The token of the Fee Router network. The Commons vault matches deliveries for causes funded through Fee Router.");
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [devBuy, setDevBuy] = useState(String(DEFAULT_DEV_BUY_SOL));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LaunchResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!image) return setError("Upload the token image first");
    setBusy(true);
    const r = await api<LaunchResult>("/api/admin/protocol/launch", { json: { description, imageUrl: image.url, devBuySol: Math.max(0, Number(devBuy) || 0), confirmMainnet: confirm } });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(r.data);
    router.refresh();
  };

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="verify">
          Launched. Mint <Mono>{done.mint}</Mono> · creator (treasury) <Mono>{short(done.creator, 6, 6)}</Mono> · <ExternalLink href={done.launchpadUrl}>pump.fun</ExternalLink>
        </Notice>
        <div className="font-mono text-[12px] text-muted">
          {done.signatures.map((s) => (
            <div key={s}>
              <ExternalLink href={solscanTx(s)}>{short(s, 8, 8)}</ExternalLink>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {blocked.length > 0 ? (
        <Notice tone="muted">
          Launch is blocked until: {blocked.join("; ")}
        </Notice>
      ) : null}
      <Field label="Description" required>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} required />
      </Field>
      <ImageUpload kind="token" value={image} onChange={setImage} label="Token image" required hint="Square PNG, JPG or WEBP; stored as a 1024 px PNG and pinned to the pump.fun metadata." disabled={busy} />
      <Field label="Dev buy (SOL)" hint="Spent by the treasury on the curve at creation. Your admin wallet funds the treasury with this plus 0.03 SOL rent and fees.">
        <Input type="number" min={0} max={50} step={0.01} value={devBuy} onChange={(e) => setDevBuy(e.target.value)} />
      </Field>
      <label className="flex items-start gap-3 text-[13px] leading-snug">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 h-4 w-4 accent-stamp" />
        <span>I understand this deploys on mainnet, spends SOL from the admin wallet, and cannot be run twice.</span>
      </label>
      {error ? <Notice>{error}</Notice> : null}
      <div>
        <Button type="submit" variant="stamp" disabled={busy || !confirm || blocked.length > 0 || !image}>
          {busy ? "Launching…" : "Launch $ROUTE on pump.fun"}
        </Button>
      </div>
    </form>
  );
}
