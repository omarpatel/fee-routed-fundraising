"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Eyebrow, Mono, Panel, Pill, Row, StatusPill } from "@/components/ui";
import { ExternalLink, PLATFORM_LABEL } from "@/components/app";
import type { Cause } from "@/lib/db/schema";
import type { StoredBrief } from "@/lib/ai/fundraiser";
import { dateTime, usd } from "@/lib/format";
import { api } from "./api";
import { Field, Notice, Select, Textarea } from "./forms";

/*
 * Operator view of one fundraiser awaiting verification: Claude's brief (facts, issues, red flags,
 * confidence) and the human decision. The brief is advice; only the form below changes status.
 */

export type VerifyCause = Pick<Cause, "id" | "slug" | "title" | "beneficiary" | "platform" | "url" | "goalUsd" | "location" | "verificationStatus" | "verificationNote" | "createdAt">;

type BriefState = { kind: "loading" } | { kind: "none"; configured: boolean } | { kind: "ready"; brief: StoredBrief } | { kind: "running"; prev: StoredBrief | null } | { kind: "error"; error: string; prev: StoredBrief | null };

const CONFIDENCE_TONE = { low: "stamp", medium: "muted", high: "verify" } as const;

function money(m: { amount: number; currency: string } | null): string {
  if (!m) return "—";
  return m.currency.toUpperCase() === "USD" ? usd(m.amount) : `${m.amount.toLocaleString("en-US")} ${m.currency.toUpperCase()}`;
}

export function CauseVerifyPanel({ cause }: { cause: VerifyCause }) {
  const router = useRouter();
  const [state, setState] = useState<BriefState>({ kind: "loading" });
  const [status, setStatus] = useState<"pending" | "verified" | "rejected">(cause.verificationStatus === "verified" || cause.verificationStatus === "rejected" ? cause.verificationStatus : "pending");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ tone: "stamp" | "verify"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ brief: StoredBrief | null; configured: boolean }>(`/api/admin/causes/${cause.id}/verify`).then((r) => {
      if (!alive) return;
      if (!r.ok) return setState({ kind: "error", error: r.error, prev: null });
      setState(r.data.brief ? { kind: "ready", brief: r.data.brief } : { kind: "none", configured: r.data.configured });
    });
    return () => {
      alive = false;
    };
  }, [cause.id]);

  const prev = state.kind === "ready" ? state.brief : state.kind === "running" || state.kind === "error" ? state.prev : null;
  const running = state.kind === "running";
  const claudeOff = state.kind === "none" && !state.configured;

  async function run() {
    setState({ kind: "running", prev });
    const r = await api<StoredBrief>(`/api/admin/causes/${cause.id}/verify`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    if (!r.ok) return setState({ kind: "error", error: r.error, prev });
    setState({ kind: "ready", brief: r.data });
  }

  async function decide(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    const r = await api<Cause>(`/api/admin/causes/${cause.id}/status`, { json: { status, note } });
    setSaving(false);
    if (!r.ok) return setSaveMsg({ tone: "stamp", text: r.error });
    setSaveMsg({ tone: "verify", text: `Recorded: ${r.data.verificationStatus}.` });
    router.refresh();
  }

  const brief = prev?.brief ?? null;

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-[22px] leading-none">{cause.title}</h3>
            <StatusPill status={cause.verificationStatus} />
            <Pill tone={cause.platform === "onchain" ? "usdc" : "muted"}>{PLATFORM_LABEL[cause.platform]}</Pill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-muted">
            <span>for {cause.beneficiary}</span>
            {cause.goalUsd ? <span>goal {usd(cause.goalUsd)}</span> : null}
            {cause.location ? <span>{cause.location}</span> : null}
            <span suppressHydrationWarning>submitted {dateTime(cause.createdAt)}</span>
            <ExternalLink href={cause.url}>fundraiser page</ExternalLink>
          </div>
        </div>
        <Button size="sm" variant="ghost" type="button" onClick={run} disabled={running || claudeOff}>
          {running ? "Checking…" : brief ? "Re-run check" : "Run check"}
        </Button>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          <Eyebrow>Claude brief · assistive</Eyebrow>
          {state.kind === "loading" ? <p className="mt-2 text-[13px] text-muted">Loading…</p> : null}
          {claudeOff ? <Notice tone="muted" className="mt-2 font-sans">Claude not configured: set ANTHROPIC_API_KEY in .env to run fact checks. Decide from the page yourself below.</Notice> : null}
          {state.kind === "none" && state.configured ? <p className="mt-2 text-[13px] text-muted">No check has been run for this fundraiser yet.</p> : null}
          {state.kind === "error" ? <Notice className="mt-2">{state.error}</Notice> : null}
          {running ? <p className="mt-2 font-mono text-[12px] text-muted">Fetching the page and comparing it with the submission…</p> : null}

          {prev && brief ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={CONFIDENCE_TONE[brief.confidence]}>{brief.confidence} confidence</Pill>
                <Pill tone={brief.platformMatches ? "verify" : "stamp"}>{brief.platformMatches ? "platform matches" : "platform mismatch"}</Pill>
                <span className="font-mono text-[11px] text-muted">
                  {prev.model} · {dateTime(new Date(prev.checkedAt))} · fetch {prev.fetch.status ?? "failed"} · {prev.fetch.textChars.toLocaleString("en-US")} chars{prev.fetch.embeddedJson ? " + embedded data" : ""}
                </span>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-ink">{brief.summary}</p>
              {prev.fetch.error ? <Notice className="mt-3">Page fetch: {prev.fetch.error}</Notice> : null}

              <div className="mt-4">
                <Row label="Title on page" value={brief.titleOnPage ?? "—"} />
                <Row label="Organizer" value={brief.organizer ?? "—"} />
                <Row label="Beneficiary" value={brief.beneficiary ?? "—"} />
                <Row label="Goal" value={money(brief.goal)} />
                <Row label="Raised" value={money(brief.raised)} />
                <Row label="Created" value={brief.createdAt ?? "—"} />
                <Row label="Location" value={brief.location ?? "—"} />
              </div>

              {brief.redFlags.length ? (
                <div className="mt-4">
                  <Eyebrow className="text-stamp">Red flags</Eyebrow>
                  <ul className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink">
                    {brief.redFlags.map((f) => (
                      <li key={f} className="flex gap-2">
                        <span className="font-mono text-stamp">×</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.consistencyIssues.length ? (
                <div className="mt-4">
                  <Eyebrow>Differences from the submission</Eyebrow>
                  <ul className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink-2">
                    {brief.consistencyIssues.map((f) => (
                      <li key={f} className="flex gap-2">
                        <span className="font-mono text-muted">·</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {brief.questionsForOrganizer.length ? (
                <div className="mt-4">
                  <Eyebrow>Questions for the organizer</Eyebrow>
                  <ol className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink-2 list-decimal pl-4">
                    {brief.questionsForOrganizer.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <form onSubmit={decide} className="flex flex-col gap-4 lg:hairline-l lg:pl-6">
          <Eyebrow>Your decision</Eyebrow>
          {cause.verificationNote ? (
            <p className="text-[12px] text-muted">
              Last note: <span className="text-ink-2">{cause.verificationNote}</span>
            </p>
          ) : null}
          <Field label="Status" required>
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="pending">pending</option>
              <option value="verified">verified</option>
              <option value="rejected">rejected</option>
            </Select>
          </Field>
          <Field label="Note" required={status === "verified"} hint={status === "verified" ? "Required. What you checked and why it holds; printed on the vault page." : "Optional."}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Page matches the submission; beneficiary confirmed by hospital letter dated…" />
          </Field>
          {saveMsg ? <Notice tone={saveMsg.tone}>{saveMsg.text}</Notice> : null}
          <div className="flex items-center justify-between gap-3">
            <Mono className="text-[11px] text-muted">{cause.slug}</Mono>
            <Button type="submit" variant={status === "verified" ? "stamp" : "ink"} disabled={saving || (status === "verified" && note.trim().length < 10)}>
              {saving ? "Saving…" : status === "verified" ? "Mark verified" : status === "rejected" ? "Mark rejected" : "Keep pending"}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
