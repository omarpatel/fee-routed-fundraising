"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Eyebrow, Panel, Pill, Row } from "@/components/ui";
import { dateTime, usdCents } from "@/lib/format";
import { api } from "./api";
import { Field, Input, Notice, Textarea } from "./forms";

/** Mirrors `ZentroStatus` from lib/zentro/session-store after JSON. */
interface Status {
  connected: boolean;
  kmsConfigured: boolean;
  sessionStored: boolean;
  canRelogin: boolean;
  cardId: string | null;
  last4: string | null;
  balanceUsd: number | null;
  lastOkAt: string | null;
  lastError: string | null;
}

/**
 * Admin: Zentro card connection. Zentro has no API; the system runs on the CardHub web session.
 * Either credentials in .env (self-healing login) or a session copied from a logged-in tab.
 */
export function ZentroPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "import" | null>(null);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(
    () =>
      api<Status>("/api/admin/zentro").then((r) => {
        if (r.ok) setStatus(r.data);
        else setError(r.error);
      }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function test() {
    setBusy("test");
    setError(null);
    const r = await api<Status>("/api/admin/zentro/test", { method: "POST", json: {} });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setStatus(r.data);
  }

  async function importSession(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("import");
    setError(null);
    const f = new FormData(e.currentTarget);
    const r = await api<Status>("/api/admin/zentro/import", { json: { cookie: String(f.get("cookie") ?? "").trim(), privateJwk: String(f.get("privateJwk") ?? "").trim(), publicJwk: String(f.get("publicJwk") ?? "").trim(), serverJwk: String(f.get("serverJwk") ?? "").trim() } });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setStatus(r.data);
    setShowImport(false);
  }

  const ready = !!status && (status.sessionStored || status.canRelogin);
  return (
    <Panel className="p-5" as="section">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>Zentro card</Eyebrow>
        {status ? status.connected ? <Pill tone="verify">connected</Pill> : ready ? <Pill tone="stamp">{status.lastError ? "error" : "unverified"}</Pill> : <Pill tone="stamp">not connected</Pill> : <Pill tone="muted">loading</Pill>}
      </div>
      <p className="mt-2 text-[13px] text-ink-2">Zentro publishes no API. Fee Router drives the CardHub session directly: top-up invoices, statement reconciliation. Sessions expire after about a day; with credentials in .env it logs itself back in.</p>
      {status ? (
        <div className="mt-3 font-mono text-[12px]">
          <Row label="Card" value={status.last4 ? `Visa •••• ${status.last4}` : <span className="text-muted">unknown until tested</span>} />
          <Row label="Balance" value={status.balanceUsd != null ? usdCents(status.balanceUsd) : <span className="text-muted">—</span>} />
          <Row label="Session" value={status.sessionStored ? "stored (encrypted)" : <span className="text-stamp">none</span>} />
          <Row label="Auto re-login" value={status.canRelogin ? "ZENTRO_USERNAME set" : <span className="text-muted">ZENTRO_USERNAME / ZENTRO_PASSWORD unset</span>} />
          <Row label="KMS" value={status.kmsConfigured ? "ok" : <span className="text-stamp">FEE_ROUTER_KMS_KEY unset</span>} />
          <Row label="Last ok" value={status.lastOkAt ? dateTime(status.lastOkAt) : <span className="text-muted">never</span>} />
          {status.lastError ? <p className="mt-2 text-stamp break-words">{status.lastError}</p> : null}
        </div>
      ) : null}
      {error ? <Notice className="mt-3">{error}</Notice> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={test} disabled={busy !== null || !status?.kmsConfigured}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowImport((v) => !v)} disabled={!status?.kmsConfigured}>
          {showImport ? "Cancel" : status?.sessionStored ? "Replace session" : "Import browser session"}
        </Button>
      </div>
      {showImport ? (
        <form onSubmit={importSession} className="mt-4 flex flex-col gap-3">
          <div className="rounded-sm bg-paper-2 hairline px-3 py-2.5 text-[12px] text-ink-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">How to copy the session</p>
            <ol className="mt-1 list-decimal pl-4 flex flex-col gap-0.5">
              <li>
                Sign in at <span className="font-mono">zentro.finance</span> and open DevTools → Application.
              </li>
              <li>
                Local storage: copy <span className="font-mono">cardhub_private_key</span>, <span className="font-mono">cardhub_public_key</span>, <span className="font-mono">cardhub_server_public_key</span> (each is a JWK JSON string).
              </li>
              <li>
                Cookies: copy the value of <span className="font-mono">connect.sid</span> as shown (starts with <span className="font-mono">s%3A</span>).
              </li>
            </ol>
          </div>
          <Field label="connect.sid cookie" required>
            <Input name="cookie" className="font-mono" placeholder="s%3A…" required autoComplete="off" />
          </Field>
          <Field label="cardhub_private_key" required>
            <Textarea name="privateJwk" className="font-mono text-[12px] min-h-[64px]" placeholder='{"crv":"X25519","d":"…","kty":"OKP","x":"…","kid":"…"}' required />
          </Field>
          <Field label="cardhub_public_key" required>
            <Textarea name="publicJwk" className="font-mono text-[12px] min-h-[48px]" placeholder='{"crv":"X25519","kty":"OKP","x":"…","kid":"…"}' required />
          </Field>
          <Field label="cardhub_server_public_key" required>
            <Textarea name="serverJwk" className="font-mono text-[12px] min-h-[48px]" placeholder='{"x":"…","crv":"X25519","kid":"…","kty":"OKP"}' required />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-muted">Stored encrypted under FEE_ROUTER_KMS_KEY, then tested immediately.</span>
            <Button size="sm" type="submit" disabled={busy !== null}>
              {busy === "import" ? "Importing…" : "Import and test"}
            </Button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
