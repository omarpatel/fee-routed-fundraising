"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useFeeRouterUser } from "@/components/auth";
import { Button, cx, Eyebrow, Panel, Pill, Stamp } from "@/components/ui";
import { CATEGORY_LABEL, CheckGlyph, PLATFORM_LABEL, ReceiptPaper, SOURCE_LABEL } from "@/components/app";
import { CopyButton } from "@/components/app/CopyButton";
import { CAUSE_PLATFORMS, TOKEN_SOURCES, type Cause, type CausePlatform, type Token, type TokenSource, type Vault } from "@/lib/db/schema";
import { bps, short, solscanTx, usd } from "@/lib/format";
import { api } from "./api";
import { AddressBlock, Field, Input, Notice, Select, Textarea, slugify } from "./forms";
import { ImageUpload, type UploadedImage } from "./ImageUpload";

const STEPS = ["cause", "vault", "token"] as const;
type Step = (typeof STEPS)[number];

export interface ConnectWizardProps {
  causes: Pick<Cause, "id" | "slug" | "title" | "platform" | "verificationStatus">[];
  vaults: Pick<Vault, "id" | "slug" | "name" | "causeId" | "treasuryAddress" | "deliveryThresholdUsd" | "donateBps">[];
}

interface VerifyResult {
  verified: boolean;
  locked: boolean;
  proofTx: string | null;
  method: "inflow" | "bags_config" | "none";
  reason: string;
}

interface StorySuggestion {
  polished: string;
  changes: string[];
  claimsToConfirm: string[];
}
type SuggestState = { kind: "idle" } | { kind: "busy" } | { kind: "ready"; suggestion: StorySuggestion } | { kind: "error"; error: string };

export function ConnectWizard({ causes, vaults }: ConnectWizardProps) {
  const router = useRouter();
  const sp = useSearchParams();
  const raw = sp.get("step");
  const step: Step = (STEPS as readonly string[]).includes(raw ?? "") ? (raw as Step) : "cause";
  const causeId = sp.get("cause");
  const vaultSlug = sp.get("vault");
  const { user, ready, login, configured } = useFeeRouterUser();

  const go = (next: Step, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(sp.toString());
    p.set("step", next);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    router.push(`/connect?${p.toString()}`);
  };

  const cause = causes.find((c) => c.id === causeId) ?? null;
  const vault = vaults.find((v) => v.slug === vaultSlug) ?? null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
      <ol className="flex min-w-0 lg:flex-col gap-2 lg:gap-0 lg:sticky lg:top-24 self-start">
        {STEPS.map((s, i) => {
          const active = s === step;
          const done = STEPS.indexOf(step) > i;
          const label = s === "cause" ? "Fundraiser" : s === "vault" ? "Vault" : "Token";
          const sub = s === "cause" ? (cause ? cause.title : "Where the money goes") : s === "vault" ? (vault ? vault.name : "Treasury + delivery rules") : "Route creator fees";
          return (
            <li key={s} className={cx("min-w-0 flex-1 lg:flex-none flex items-start gap-2 sm:gap-3 py-3 lg:rule-dashed", active ? "text-ink" : "text-muted")}>
              <span className={cx("mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px]", active ? "bg-ink text-paper" : done ? "bg-verify text-paper" : "hairline")}>{done ? <CheckGlyph /> : i + 1}</span>
              <span className="min-w-0">
                <span className="block font-mono text-[11px] uppercase tracking-[0.12em] sm:tracking-[0.18em] truncate">{label}</span>
                <span className="hidden lg:block mt-0.5 text-[12px] truncate">{sub}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="min-w-0">
        {ready && !user ? (
          <Notice tone="muted" className="mb-6 flex flex-wrap items-center justify-between gap-3 font-sans">
            <span>{configured ? "Sign in to save what you create here." : "Sign-in is not configured (GOOGLE_CLIENT_ID). Writes will be rejected."}</span>
            {configured ? (
              <Button size="sm" onClick={() => login()}>
                Sign in
              </Button>
            ) : null}
          </Notice>
        ) : null}
        {step === "cause" ? <CauseStep causes={causes} onDone={(id) => go("vault", { cause: id })} /> : null}
        {step === "vault" ? <VaultStep cause={cause} causes={causes} vaults={vaults} onPickCause={(id) => go("vault", { cause: id })} onDone={(slug) => go("token", { vault: slug })} onBack={() => go("cause")} /> : null}
        {step === "token" ? <TokenStep vault={vault} vaults={vaults} onPickVault={(slug) => go("token", { vault: slug })} onBack={() => go("vault")} /> : null}
      </div>
    </div>
  );
}

/* ---------------- step 1: cause ---------------- */

function CauseStep({ causes, onDone }: { causes: ConnectWizardProps["causes"]; onDone: (id: string) => void }) {
  const [platform, setPlatform] = useState<CausePlatform>("gofundme");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [story, setStory] = useState("");
  const [suggest, setSuggest] = useState<SuggestState>({ kind: "idle" });

  async function suggestEdits() {
    setSuggest({ kind: "busy" });
    const r = await api<StorySuggestion>("/api/ai/story", { json: { story } });
    if (!r.ok) return setSuggest({ kind: "error", error: r.error });
    setSuggest({ kind: "ready", suggestion: r.data });
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const title = String(f.get("title") ?? "").trim();
    const goal = Number(f.get("goalUsd"));
    const body = {
      slug: slugify(title),
      title,
      summary: String(f.get("summary") ?? "").trim(),
      story,
      beneficiary: String(f.get("beneficiary") ?? "").trim(),
      platform,
      url: String(f.get("url") ?? "").trim(),
      onchainAddress: platform === "onchain" ? String(f.get("onchainAddress") ?? "").trim() : undefined,
      goalUsd: goal > 0 ? goal : undefined,
      imageUrl: image?.url,
      location: String(f.get("location") ?? "").trim() || undefined,
      category: String(f.get("category") ?? "medical"),
    };
    const r = await api<Cause>("/api/causes", { json: body });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone(r.data.id);
  }

  return (
    <div>
      <Eyebrow>Step 1 of 3</Eyebrow>
      <h2 className="mt-2 font-display text-[34px] leading-none">Where does the money go?</h2>
      <p className="mt-3 text-[14px] text-ink-2 max-w-[56ch]">Link the fundraiser exactly as it exists today. Fee Router delivers through that page&apos;s own rail; you do not need to move it.</p>

      {causes.length > 0 ? (
        <Panel className="mt-6 p-4">
          <Eyebrow>Or pick an existing fundraiser</Eyebrow>
          <ul className="mt-2 flex flex-col">
            {causes.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 rule-dashed">
                <span className="min-w-0 flex items-center gap-2 text-[13px]">
                  <span className="truncate">{c.title}</span>
                  <Pill tone={c.platform === "onchain" ? "usdc" : "muted"}>{PLATFORM_LABEL[c.platform]}</Pill>
                </span>
                <Button size="sm" variant="ghost" onClick={() => onDone(c.id)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <form onSubmit={submit} className="mt-8 grid gap-5 sm:grid-cols-2">
        <Field label="Title" required className="sm:col-span-2">
          <Input name="title" required minLength={4} maxLength={120} placeholder="Hope Ward: pediatric cancer treatment" />
        </Field>
        <Field label="One-line summary" required className="sm:col-span-2">
          <Input name="summary" required maxLength={200} placeholder="Chemotherapy and surgery for children whose families cannot pay." />
        </Field>
        <Field label="Story" required className="sm:col-span-2" hint="Plain language. What happened, what the money buys, who receives it.">
          <Textarea name="story" required minLength={40} value={story} onChange={(e) => setStory(e.target.value)} />
        </Field>
        <div className="sm:col-span-2 -mt-2 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost" type="button" disabled={suggest.kind === "busy" || story.trim().length < 40} onClick={suggestEdits}>
              {suggest.kind === "busy" ? "Reading…" : "Suggest edits"}
            </Button>
            <span className="text-[12px] text-muted">Claude tidies grammar and structure and lists the claims a reviewer will check. Facts are never added. You choose whether to accept.</span>
          </div>
          {suggest.kind === "error" ? <Notice tone={/not configured/i.test(suggest.error) ? "muted" : "stamp"}>{suggest.error}</Notice> : null}
          {suggest.kind === "ready" ? (
            <Panel className="p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Eyebrow>Before</Eyebrow>
                  <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{story}</p>
                </div>
                <div>
                  <Eyebrow>After</Eyebrow>
                  <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{suggest.suggestion.polished}</p>
                </div>
              </div>
              {suggest.suggestion.changes.length ? (
                <div className="mt-4">
                  <Eyebrow>Changes</Eyebrow>
                  <ul className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink-2">
                    {suggest.suggestion.changes.map((c) => (
                      <li key={c}>· {c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {suggest.suggestion.claimsToConfirm.length ? (
                <div className="mt-4">
                  <Eyebrow>Claims a reviewer will confirm</Eyebrow>
                  <ul className="mt-1.5 flex flex-col gap-1 text-[13px] text-ink-2">
                    {suggest.suggestion.claimsToConfirm.map((c) => (
                      <li key={c}>· {c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mt-4 flex items-center gap-2">
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    if (suggest.kind === "ready") setStory(suggest.suggestion.polished);
                    setSuggest({ kind: "idle" });
                  }}
                >
                  Use the edited version
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setSuggest({ kind: "idle" })}>
                  Keep mine
                </Button>
              </div>
            </Panel>
          ) : null}
        </div>
        <Field label="Beneficiary" required hint="Person or organisation that receives the funds.">
          <Input name="beneficiary" required placeholder="Hope Ward patients' families" />
        </Field>
        <Field label="Platform" required>
          <Select name="platform" value={platform} onChange={(e) => setPlatform(e.target.value as CausePlatform)}>
            {CAUSE_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fundraiser URL" required className="sm:col-span-2">
          <Input name="url" type="url" required placeholder="https://www.gofundme.com/f/…" />
        </Field>
        {platform === "onchain" ? (
          <Field label="USDC recipient address" required className="sm:col-span-2" hint="Solana address that receives USDC directly.">
            <Input name="onchainAddress" required minLength={32} maxLength={44} className="font-mono" />
          </Field>
        ) : null}
        <Field label="Goal (USD)">
          <Input name="goalUsd" type="number" min={0} step={1} placeholder="50000" />
        </Field>
        <Field label="Category">
          <Select name="category" defaultValue="medical">
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <Input name="location" placeholder="Cairo, Egypt" />
        </Field>
        <ImageUpload kind="cause" value={image} onChange={setImage} label="Cover image" shape="wide" className="sm:col-span-2" hint="Optional. PNG, JPG or WEBP up to 5 MB; shown on the vault page." disabled={busy} />
        {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
        <div className="sm:col-span-2 flex items-center justify-between gap-3 pt-2">
          <span className="text-[12px] text-muted">Every fundraiser is reviewed before its first delivery.</span>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save fundraiser →"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- step 2: vault ---------------- */

function VaultStep({ cause, causes, vaults, onPickCause, onDone, onBack }: { cause: ConnectWizardProps["causes"][number] | null; causes: ConnectWizardProps["causes"]; vaults: ConnectWizardProps["vaults"]; onPickCause: (id: string) => void; onDone: (slug: string) => void; onBack: () => void }) {
  const [donateBps, setDonateBps] = useState(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Vault | null>(null);
  const existing = cause ? vaults.filter((v) => v.causeId === cause.id) : [];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cause) return;
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const r = await api<Vault>("/api/vaults", {
      json: { slug: slugify(name), name, tagline: String(f.get("tagline") ?? "").trim() || undefined, causeId: cause.id, donateBps, deliveryThresholdUsd: Number(f.get("deliveryThresholdUsd")) || 250 },
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setCreated(r.data);
  }

  if (!cause) {
    return (
      <div>
        <Eyebrow>Step 2 of 3</Eyebrow>
        <h2 className="mt-2 font-display text-[34px] leading-none">Pick the fundraiser first.</h2>
        {causes.length ? (
          <ul className="mt-6 flex flex-col">
            {causes.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 rule-dashed">
                <span className="truncate text-[13px]">{c.title}</span>
                <Button size="sm" variant="ghost" onClick={() => onPickCause(c.id)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="ghost" className="mt-6" onClick={onBack}>
          ← Add a fundraiser
        </Button>
      </div>
    );
  }

  if (created) {
    return (
      <div>
        <Eyebrow>Step 2 of 3</Eyebrow>
        <h2 className="mt-2 font-display text-[34px] leading-none">Vault created.</h2>
        <ReceiptPaper className="mt-6" inner="p-5">
          <div className="flex items-center justify-between">
            <span className="font-display text-[22px]">{created.name}</span>
            <Stamp animate>New</Stamp>
          </div>
          <div className="mt-4">
            <AddressBlock label="USDC treasury (custodial)" value={created.treasuryAddress} />
            <div className="mt-2 flex gap-3">
              <CopyButton value={created.treasuryAddress} label="copy address" />
            </div>
          </div>
          <p className="mt-4 text-[13px] text-ink-2">
            Donates {bps(created.donateBps)} of swept fees. A delivery queues once the treasury holds {usd(created.deliveryThresholdUsd)}.
          </p>
        </ReceiptPaper>
        <div className="mt-6 flex justify-end">
          <Button onClick={() => onDone(created.slug)}>Connect a token →</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Eyebrow>Step 2 of 3</Eyebrow>
      <h2 className="mt-2 font-display text-[34px] leading-none">Create the vault.</h2>
      <p className="mt-3 text-[14px] text-ink-2 max-w-[56ch]">
        A vault is the USDC treasury for <span className="font-medium text-ink">{cause.title}</span>. Fees from every connected token sweep here; deliveries leave from here.
      </p>

      {existing.length ? (
        <Panel className="mt-6 p-4">
          <Eyebrow>Existing vaults for this fundraiser</Eyebrow>
          <ul className="mt-2 flex flex-col">
            {existing.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-2 rule-dashed">
                <span className="text-[13px]">
                  {v.name} <span className="font-mono text-[11px] text-muted">{short(v.treasuryAddress, 6, 6)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => onDone(v.slug)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <form onSubmit={submit} className="mt-8 grid gap-5 sm:grid-cols-2">
        <Field label="Vault name" required>
          <Input name="name" required minLength={3} maxLength={60} placeholder="Hope Ward Vault" />
        </Field>
        <Field label="Tagline">
          <Input name="tagline" maxLength={80} placeholder="Every trade is a dose closer." />
        </Field>
        <Field label="Delivery threshold (USD)" hint="Auto-queue a delivery once the treasury reaches this.">
          <Input name="deliveryThresholdUsd" type="number" min={25} step={1} defaultValue={250} />
        </Field>
        <Field label={`Donate ${bps(donateBps)} of fees`} hint="The rest stays for gas and operator costs. 100% is the default.">
          <input type="range" min={5000} max={10000} step={100} value={donateBps} onChange={(e) => setDonateBps(Number(e.target.value))} className="w-full accent-ink h-10" aria-label="Donate share in basis points" />
        </Field>
        {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
        <div className="sm:col-span-2 flex items-center justify-between gap-3 pt-2">
          <Button variant="ghost" type="button" onClick={onBack}>
            ← Back
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating treasury…" : "Create vault →"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- step 3: token ---------------- */

function TokenStep({ vault, vaults, onPickVault, onBack }: { vault: ConnectWizardProps["vaults"][number] | null; vaults: ConnectWizardProps["vaults"]; onPickVault: (slug: string) => void; onBack: () => void }) {
  const [source, setSource] = useState<TokenSource>("pumpfun");
  const [routeBps, setRouteBps] = useState(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [verify, setVerify] = useState<{ busy: boolean; result: VerifyResult | null; error: string | null }>({ busy: false, result: null, error: null });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!vault) return;
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const r = await api<Token>(`/api/vaults/${vault.slug}/tokens`, {
      json: {
        mint: String(f.get("mint") ?? "").trim(),
        symbol: String(f.get("symbol") ?? "").trim().toUpperCase().replace(/^\$/, ""),
        name: String(f.get("name") ?? "").trim(),
        imageUrl: image?.url,
        source,
        launchpadUrl: String(f.get("launchpadUrl") ?? "").trim() || undefined,
        creatorWallet: String(f.get("creatorWallet") ?? "").trim() || undefined,
        routeBps,
      },
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setToken(r.data);
  }

  async function runVerify() {
    if (!token) return;
    setVerify({ busy: true, result: null, error: null });
    const r = await api<VerifyResult>(`/api/tokens/${token.id}/verify`, { method: "POST", json: {} });
    setVerify(r.ok ? { busy: false, result: r.data, error: null } : { busy: false, result: null, error: r.error });
  }

  if (!vault) {
    return (
      <div>
        <Eyebrow>Step 3 of 3</Eyebrow>
        <h2 className="mt-2 font-display text-[34px] leading-none">Which vault receives the fees?</h2>
        {vaults.length ? (
          <ul className="mt-6 flex flex-col">
            {vaults.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-2 rule-dashed">
                <span className="text-[13px]">{v.name}</span>
                <Button size="sm" variant="ghost" onClick={() => onPickVault(v.slug)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-[14px] text-muted">You have no vaults yet.</p>
        )}
        <Button variant="ghost" className="mt-6" onClick={onBack}>
          ← Create a vault
        </Button>
      </div>
    );
  }

  if (token) {
    const addr = token.routeAddress;
    return (
      <div>
        <Eyebrow>Step 3 of 3 · route instructions</Eyebrow>
        <h2 className="mt-2 font-display text-[34px] leading-none">Point ${token.symbol}&apos;s fees at this address.</h2>
        <p className="mt-3 text-[14px] text-ink-2 max-w-[56ch]">This route address belongs to {vault.name} only. Attribution is by address: whatever arrives here is credited to ${token.symbol}.</p>

        <Panel className="mt-6 p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[13px]">
              ${token.symbol} · {SOURCE_LABEL[token.source]} · route {bps(token.routeBps)}
            </span>
            <CopyButton value={addr} label="copy address" />
          </div>
          <div className="mt-3">
            <AddressBlock label="Route address" value={addr} />
          </div>
          <ol className="mt-5 flex flex-col gap-3 text-[14px] text-ink-2 list-decimal pl-5">
            {token.source === "pumpfun" ? (
              <>
                <li>
                  Open your coin on pump.fun and go to <span className="font-medium text-ink">Creator Rewards</span>.
                </li>
                <li>
                  Set the creator fee recipient to the route address above. This is a <span className="font-medium text-ink">one-time, permanently locked</span> change on-chain.
                </li>
                <li>Come back and press Verify route. Fee Router looks for the on-chain redirect and marks the route locked.</li>
              </>
            ) : token.source === "bags" ? (
              <>
                <li>Open the token on Bags and edit its fee-share configuration.</li>
                <li>
                  Add the route address above as a fee-share claimer at <span className="font-mono text-ink">{token.routeBps} bps</span> ({bps(token.routeBps)}).
                </li>
                <li>Publish the config, then press Verify route. Fee Router reads the Bags config and marks the route locked.</li>
              </>
            ) : token.source === "meteora" ? (
              <>
                <li>Set the route address as the fee claimer on your Meteora position, or forward claimed fees to it.</li>
                <li>Press Verify route once the first fee lands. Meteora routes verify by inflow and stay marked unlocked.</li>
              </>
            ) : (
              <>
                <li>Send creator fees to the route address above whenever you claim them.</li>
                <li>Manual routes verify by inflow and remain marked unlocked on the public vault page.</li>
              </>
            )}
          </ol>
        </Panel>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={runVerify} disabled={verify.busy}>
            {verify.busy ? "Checking on-chain…" : "Verify route"}
          </Button>
          <Link href={`/v/${vault.slug}`} className="font-mono text-[12px] uppercase tracking-[0.12em] underline underline-offset-4">
            Open vault page
          </Link>
        </div>
        {verify.error ? <Notice className="mt-4">{verify.error}</Notice> : null}
        {verify.result ? (
          <Panel className={cx("mt-4 p-4 flex items-start gap-3", verify.result.verified && "border-verify/40")}>
            {verify.result.verified ? <Stamp animate className="text-[18px] text-verify! border-verify!">Verified</Stamp> : <Stamp animate className="text-[18px]">Not yet</Stamp>}
            <div className="text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={verify.result.locked ? "verify" : "stamp"}>{verify.result.locked ? "locked" : "unlocked"}</Pill>
                <Pill tone="muted">via {verify.result.method}</Pill>
                {verify.result.proofTx ? (
                  <a href={solscanTx(verify.result.proofTx)} target="_blank" rel="noreferrer" className="font-mono text-[11px] underline underline-offset-4">
                    {short(verify.result.proofTx, 6, 6)}
                  </a>
                ) : null}
              </div>
              <p className="mt-2 text-ink-2">{verify.result.reason}</p>
            </div>
          </Panel>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <Eyebrow>Step 3 of 3</Eyebrow>
      <h2 className="mt-2 font-display text-[34px] leading-none">Connect a token to {vault.name}.</h2>
      <p className="mt-3 text-[14px] text-ink-2 max-w-[56ch]">Fee Router creates a dedicated route address for this token. You then point the token&apos;s creator fees at it on the launchpad.</p>

      <form onSubmit={submit} className="mt-8 grid gap-5 sm:grid-cols-2">
        <Field label="Mint address" required className="sm:col-span-2">
          <Input name="mint" required minLength={32} maxLength={44} className="font-mono" placeholder="Token mint (base58)" />
        </Field>
        <Field label="Symbol" required>
          <Input name="symbol" required maxLength={12} placeholder="CURE" className="font-mono uppercase" />
        </Field>
        <Field label="Name" required>
          <Input name="name" required maxLength={60} placeholder="Cure" />
        </Field>
        <Field label="Source" required>
          <Select
            value={source}
            onChange={(e) => {
              const s = e.target.value as TokenSource;
              setSource(s);
              if (s === "pumpfun") setRouteBps(10000);
            }}
          >
            {TOKEN_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Launchpad URL">
          <Input name="launchpadUrl" type="url" placeholder={source === "pumpfun" ? "https://pump.fun/coin/…" : source === "bags" ? "https://bags.fm/…" : "https://…"} />
        </Field>
        <Field label="Creator wallet" hint="Wallet that currently receives creator fees. Used to match the redirect.">
          <Input name="creatorWallet" minLength={32} maxLength={44} className="font-mono" />
        </Field>
        <ImageUpload kind="token" value={image} onChange={setImage} label="Token image" shape="square" hint="Optional. Square PNG, JPG or WEBP; shown next to the token on the vault page." disabled={busy} />
        <Field label={`Route ${bps(routeBps)} of creator fees`} className="sm:col-span-2" hint={source === "bags" ? "Bags fee-share supports partial routes. Set the bps you will configure as claimer share." : "pump.fun redirects are all-or-nothing; keep 100%."}>
          <input type="range" min={500} max={10000} step={100} value={routeBps} onChange={(e) => setRouteBps(Number(e.target.value))} disabled={source === "pumpfun"} className="w-full accent-ink h-10 disabled:opacity-40" aria-label="Route share in basis points" />
        </Field>
        {error ? <Notice className="sm:col-span-2">{error}</Notice> : null}
        <div className="sm:col-span-2 flex items-center justify-between gap-3 pt-2">
          <Button variant="ghost" type="button" onClick={onBack}>
            ← Back
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating route…" : "Create route address →"}
          </Button>
        </div>
      </form>
    </div>
  );
}
