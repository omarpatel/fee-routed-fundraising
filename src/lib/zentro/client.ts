import { CompactEncrypt, compactDecrypt, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

/**
 * Zentro CardHub client.
 *
 * Zentro publishes no API. This speaks the same end-to-end-encrypted protocol the CardHub web app
 * uses (`/dash/api/v1/*`, mapped from app.js v13 on 2026-09-23):
 *   - request bodies:  hex( JWE[ECDH-ES+A256KW, A256GCM] to the server X25519 key ) of JSON + clientPublicKey
 *   - responses:       hex( JWE to the client X25519 key ), or plain JSON
 *   - session:         httpOnly cookie `connect.sid`, obtained via POST /auth {username,password}
 *
 * The client is self-healing: with credentials it logs in and registers a fresh key pair when the
 * session is rejected. Without credentials it can run on a session exported from a browser
 * (cookie + private JWK) until that session expires.
 *
 * Because this is an unofficial integration, every call is typed narrowly and failures surface as
 * `ZentroError` so the ledger can fall back to the operator runbook rather than guess.
 */

const BASE = "https://zentro.finance";
const ALG = "ECDH-ES+A256KW";
const ENC = "A256GCM";

export class ZentroError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = "ZentroError";
  }
}

export interface ZentroSession {
  cookie: string;
  privateJwk: JWK;
  publicJwk: JWK;
  serverJwk: JWK;
}

export interface ZentroCredentials {
  username: string;
  password: string;
}

export interface ZentroCard {
  id: string;
  last4?: string;
  status?: string;
  [k: string]: unknown;
}

export interface ZentroCardDetail {
  cardNumber?: string;
  cardHolder?: string;
  expiryDate?: string;
  balance?: number | string;
  currency?: string;
  status?: string;
  [k: string]: unknown;
}

export interface ZentroTransaction {
  id?: string;
  date: string;
  merchant?: string;
  description?: string;
  amount: number | string;
  currency?: string;
  category?: string;
  kind?: "purchase" | "refund" | "deposit" | "payment";
  sign?: 1 | -1;
  type?: "credit" | "debit";
  status?: string;
  declinedReason?: string;
  [k: string]: unknown;
}

export type ZentroDepositCurrency = "SOL-USDC" | "SOL-USDT" | "ETH-USDC" | "ETH-USDT" | "TRX-USDT";

export interface ZentroBridge {
  bridge_id: string;
  deposit_address: string;
  amount_to_send: string | number;
  currency: string;
  expected_usdc: string | number;
  expires_in_seconds: number;
}

export interface ZentroBridgeStatus {
  status: string;
  [k: string]: unknown;
}

const MIN_DEPOSIT_USD = 15;

function hexToUtf8(hex: string): string {
  return Buffer.from(hex.trim(), "hex").toString("utf8");
}
function utf8ToHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}
/** Zentro error bodies are `{ error: string }`; anything else has no message. */
function errorOf(data: unknown): string | undefined {
  return data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : undefined;
}

export class ZentroClient {
  private session: ZentroSession | null;
  private readonly creds: ZentroCredentials | null;
  private readonly base: string;
  private loginInFlight: Promise<void> | null = null;

  constructor(opts: { session?: ZentroSession | null; credentials?: ZentroCredentials | null; onSession?: (s: ZentroSession) => void | Promise<void>; baseUrl?: string }) {
    this.session = opts.session ?? null;
    this.creds = opts.credentials ?? null;
    this.onSession = opts.onSession;
    this.base = opts.baseUrl ?? BASE;
  }
  private readonly onSession?: (s: ZentroSession) => void | Promise<void>;

  get hasSession(): boolean {
    return this.session !== null;
  }
  get canLogin(): boolean {
    return this.creds !== null;
  }

  /** Server X25519 public key (plain JSON endpoint). */
  static async serverKey(baseUrl = BASE): Promise<JWK> {
    const r = await fetch(`${baseUrl}/dash/api/v1/init`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new ZentroError(`init failed: ${r.status}`, r.status, "init");
    const data = (await r.json()) as { publicKey?: JWK };
    if (!data.publicKey?.x) throw new ZentroError("init returned no publicKey", r.status, "init");
    return data.publicKey;
  }

  /** Fresh key pair + login + key registration. Replaces the current session. */
  async login(): Promise<ZentroSession> {
    if (!this.creds) throw new ZentroError("Zentro credentials not configured");
    const serverJwk = await ZentroClient.serverKey(this.base);
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = { ...(await exportJWK(publicKey)), kid: crypto.randomUUID() };
    const draft: ZentroSession = { cookie: "", privateJwk, publicJwk, serverJwk };

    const body = await this.encrypt(draft, { username: this.creds.username, password: this.creds.password });
    const r = await fetch(`${this.base}/dash/api/v1/auth`, { method: "POST", headers: { "content-type": "text/plain" }, body });
    const setCookie = r.headers.get("set-cookie") ?? "";
    const m = /connect\.sid=([^;]+)/.exec(setCookie);
    const data = await this.decode(draft, r);
    if (!r.ok || !m) throw new ZentroError(errorOf(data) ?? `login failed: ${r.status}`, r.status, "auth");
    draft.cookie = m[1];
    this.session = draft;
    // No re-login retry here: a rejected setup would re-enter login and await its own in-flight promise forever.
    await this.raw("setup", { method: "POST", body: { publicKey: publicJwk } }, false);
    await this.onSession?.(draft);
    return draft;
  }

  private async ensureSession(): Promise<ZentroSession> {
    if (this.session) return this.session;
    if (!this.creds) throw new ZentroError("No Zentro session and no credentials to log in");
    this.loginInFlight ??= this.login().then(() => undefined).finally(() => (this.loginInFlight = null));
    await this.loginInFlight;
    return this.session!;
  }

  private async encrypt(s: ZentroSession, payload: Record<string, unknown>): Promise<string> {
    const pub = await importJWK(s.serverJwk, "ECDH-ES");
    const jwe = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ ...payload, clientPublicKey: s.publicJwk })))
      .setProtectedHeader({ alg: ALG, enc: ENC, kid: s.serverJwk.kid })
      .encrypt(pub);
    return utf8ToHex(jwe);
  }

  private async decode(s: ZentroSession, r: Response): Promise<unknown> {
    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (ct.includes("application/json")) return text ? JSON.parse(text) : null;
    if (!text.trim()) return null;
    const priv = await importJWK(s.privateJwk, "ECDH-ES");
    const { plaintext } = await compactDecrypt(hexToUtf8(text), priv);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  private async raw<T>(path: string, opts: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {}, retry = true): Promise<T> {
    const s = await this.ensureSession();
    const init: RequestInit = { method: opts.method ?? "GET", headers: { cookie: `connect.sid=${s.cookie}` } };
    if (opts.body) {
      init.body = await this.encrypt(s, opts.body);
      init.headers = { ...init.headers, "content-type": "text/plain" };
    }
    const r = await fetch(`${this.base}/dash/api/v1/${path}`, init);
    if ((r.status === 401 || r.status === 403) && retry && this.creds) {
      this.session = null;
      return this.raw<T>(path, opts, false);
    }
    const data = await this.decode(s, r);
    if (!r.ok) throw new ZentroError(errorOf(data) ?? `${path} failed: ${r.status}`, r.status, path);
    return data as T;
  }

  /** Session probe. Throws when the session is dead and cannot be renewed. */
  async state(): Promise<{ user?: Record<string, unknown> } & Record<string, unknown>> {
    return this.raw("state");
  }
  async cards(): Promise<ZentroCard[]> {
    const d = await this.raw<{ cards?: ZentroCard[] }>("list");
    return d.cards ?? [];
  }
  async card(cardId: string): Promise<ZentroCardDetail> {
    return this.raw(`item?cardId=${encodeURIComponent(cardId)}`);
  }
  async history(cardId?: string): Promise<ZentroTransaction[]> {
    const d = await this.raw<ZentroTransaction[] | null>(cardId ? `history?cardId=${encodeURIComponent(cardId)}` : "history");
    return d ?? [];
  }
  /** Account-level deposit base address (input to `createDeposit`). */
  async depositBase(): Promise<string> {
    const d = await this.raw<{ depositAddress?: string }>("target");
    if (!d.depositAddress) throw new ZentroError("target returned no depositAddress", undefined, "target");
    return d.depositAddress;
  }
  /**
   * Create a top-up invoice: Zentro returns a one-time deposit address and the exact amount to send,
   * valid for `expires_in_seconds`. USD amount, minimum $15.
   */
  async createDeposit(amountUsd: number, currency: ZentroDepositCurrency = "SOL-USDC"): Promise<ZentroBridge> {
    if (!(amountUsd >= MIN_DEPOSIT_USD)) throw new ZentroError(`Zentro minimum deposit is $${MIN_DEPOSIT_USD}`);
    const baseAddress = await this.depositBase();
    const amount = Math.round(amountUsd * 100) / 100;
    const d = await this.raw<ZentroBridge>("transfer", { method: "POST", body: { amount, currency, baseAddress } });
    if (!d.bridge_id || !d.deposit_address) throw new ZentroError(errorOf(d) ?? "transfer returned no bridge", undefined, "transfer");
    return d;
  }
  async depositStatus(bridgeId: string): Promise<ZentroBridgeStatus> {
    return this.raw(`transfer/${encodeURIComponent(bridgeId)}`);
  }
  /** Referral/rewards bookkeeping the web app fires after a completed deposit. Best-effort. */
  async recordFunding(amountUsd: number, currency: ZentroDepositCurrency, bridgeId: string): Promise<void> {
    await this.raw("fund", { method: "POST", body: { amount: amountUsd, currency, txHash: bridgeId } }).catch(() => undefined);
  }

  exportSession(): ZentroSession | null {
    return this.session;
  }
}

export const ZENTRO_MIN_DEPOSIT_USD = MIN_DEPOSIT_USD;

/** Normalise Zentro's mixed amount/sign encodings into signed USD (+ in, − out). */
export function txSignedUsd(tx: ZentroTransaction): number {
  const n = Math.abs(Number(tx.amount));
  const credit = tx.sign != null ? tx.sign > 0 : tx.type === "credit";
  return credit ? n : -n;
}
