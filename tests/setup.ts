import { copyFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { inject } from "vitest";

/**
 * Runs before every test file, before any `@/lib/*` import: `src/lib/env.ts` and `src/lib/db`
 * read `process.env` at import time, so the environment must be final here.
 *
 * - Every file gets a private copy of the schema-only template DB built in `global-setup.ts`.
 * - No integration is configured: RPC, Helius, Jupiter, Bags, Google and Zentro are all absent,
 *   so anything that would talk to a network is a visible "not configured" path.
 * - A fake KMS key and session secret so custodial keys and cookie sessions work locally.
 */
const dir = mkdtempSync(path.join(inject("feeRouterTestDir"), "case-"));
const dbPath = path.join(dir, "fee-router.db");
copyFileSync(path.join(inject("feeRouterTestDir"), "template.db"), dbPath);

for (const k of Object.keys(process.env)) {
  if (/^(DATABASE_|FEE_ROUTER_|SOLANA_|HELIUS_|JUPITER_|BAGS_|GOOGLE_|SESSION_|ZENTRO_|OPERATOR_EMAILS|ADMIN_EMAILS|WALLET_|NEXT_PUBLIC_)/.test(k)) delete process.env[k];
}
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.FEE_ROUTER_KMS_KEY = "0f".repeat(32);
process.env.SESSION_SECRET = "fee-router-test-session-secret-0123456789abcdef";
process.env.OPERATOR_EMAILS = "ops@test.local, Second.Op@test.local";
process.env.ADMIN_EMAILS = "admin@test.local";
