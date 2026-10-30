import path from "node:path";
import { z } from "zod";

/**
 * Environment, parsed once. Integration keys are optional: every module that needs one
 * checks `configured.*` and returns a visible "not configured" result instead of faking success.
 */
const schema = z.object({
  DATABASE_URL: z.string().default("file:./data/fee-router.db"),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  /** Where uploads, receipt evidence and verification briefs are written. Defaults to the SQLite file's directory. */
  DATA_DIR: z.string().optional(),
  /** 32-byte hex key for AES-256-GCM over custodial secrets. */
  FEE_ROUTER_KMS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "FEE_ROUTER_KMS_KEY must be 64 hex chars (32 bytes)")
    .optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_WEBHOOK_SECRET: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  BAGS_API_KEY: z.string().optional(),
  /** Google OAuth 2.0 web client (direct sign-in, Gmail scopes for operators). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Separate Testing-mode client that may request restricted Gmail scopes for operators. */
  GOOGLE_GMAIL_CLIENT_ID: z.string().optional(),
  GOOGLE_GMAIL_CLIENT_SECRET: z.string().optional(),
  /** Session cookie signing secret (32+ chars). */
  SESSION_SECRET: z.string().min(32).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  /** Zentro CardHub credentials for automatic re-login; card id optional (first card otherwise). */
  ZENTRO_USERNAME: z.string().optional(),
  ZENTRO_PASSWORD: z.string().optional(),
  ZENTRO_CARD_ID: z.string().optional(),
  OPERATOR_EMAILS: z.string().default(""),
  ADMIN_EMAILS: z.string().default(""),
  /** Per-transaction cap on custodial withdrawals, USD. */
  WALLET_WITHDRAW_MAX_USD: z.coerce.number().positive().default(5000),
  /** Local demo only: act as this seeded user without Google. Ignored in production. */
  FEE_ROUTER_DEV_SESSION_EMAIL: z.string().optional(),
  /** Claude, for assistive fact-checking briefs, story suggestions and reconciliation rationales. Never decides anything. */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
});

export type Env = z.infer<typeof schema>;

function parse(): Env {
  // A copied .env.example leaves keys blank; blank means "not configured", not "invalid URL".
  const source: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v.trim() !== "") source[k] = v;
  const r = schema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return r.data;
}

export const env: Env = parse();

/** Booleans the rest of the system branches on. Absent ⇒ that path is a logged no-op. */
export const configured = {
  kms: !!env.FEE_ROUTER_KMS_KEY,
  /** A dedicated RPC. Public mainnet is used as a read-only fallback when absent. */
  rpc: !!env.SOLANA_RPC_URL,
  helius: !!env.HELIUS_API_KEY && !!env.HELIUS_WEBHOOK_SECRET,
  jupiter: !!env.JUPITER_API_KEY,
  bags: !!env.BAGS_API_KEY,
  /** On-chain anchoring needs a signer we can decrypt and an RPC that accepts writes. */
  anchor: !!env.FEE_ROUTER_KMS_KEY && !!env.SOLANA_RPC_URL,
  /** Zentro can re-login by itself; without credentials it runs on an imported browser session. */
  zentroLogin: !!env.ZENTRO_USERNAME && !!env.ZENTRO_PASSWORD,
  google: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && !!env.SESSION_SECRET,
  gmail: !!env.GOOGLE_GMAIL_CLIENT_ID && !!env.GOOGLE_GMAIL_CLIENT_SECRET,
  claude: !!env.ANTHROPIC_API_KEY,
} as const;

function emailSet(csv: string): ReadonlySet<string> {
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}
export const operatorEmails: ReadonlySet<string> = emailSet(env.OPERATOR_EMAILS);
export const adminEmails: ReadonlySet<string> = emailSet(env.ADMIN_EMAILS);

/**
 * Files the app writes (uploads, receipt evidence, verification briefs) live beside the SQLite file so
 * they share its persistence: the Railway volume in production, `./data` locally. A remote libsql
 * database has no local directory, so it falls back to `./data`.
 */
export function resolveDataDir(databaseUrl: string, override?: string): string {
  if (override) return path.resolve(override);
  return path.resolve(databaseUrl.startsWith("file:") ? path.dirname(databaseUrl.slice("file:".length)) : "data");
}
export const dataDir: string = resolveDataDir(env.DATABASE_URL, env.DATA_DIR);
