import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export type FeeRouterDb = LibSQLDatabase<typeof schema>;

/**
 * libsql: `file:./data/fee-router.db` locally, `file:/data/fee-router.db` on the Railway volume, or
 * `libsql://…` (Turso). Opened lazily on first use: `next build` collects page data in an
 * environment where the volume is not mounted, and no page needs the database at build time.
 * One client per process; Next dev hot-reload reuses via globalThis.
 */
const url = process.env.DATABASE_URL ?? "file:./data/fee-router.db";
const authToken = process.env.DATABASE_AUTH_TOKEN;

const g = globalThis as unknown as { __feeRouterDb?: FeeRouterDb };

function open(): FeeRouterDb {
  if (g.__feeRouterDb) return g.__feeRouterDb;
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length);
    if (!path.startsWith(":")) mkdirSync(dirname(path), { recursive: true });
  }
  // Single-writer SQLite shared by the request handlers and the embedded worker (and `pnpm worker`
  // locally). `timeout` is the busy timeout for every connection in the client's pool (a PRAGMA
  // would reach only one of them): a second writer waits instead of failing with SQLITE_BUSY, which
  // after an on-chain transfer would lose the record of it. WAL keeps readers off the writer's lock.
  const client = createClient({ url, authToken, timeout: 5000 });
  if (url.startsWith("file:")) void client.execute("PRAGMA journal_mode = WAL");
  const instance = drizzle(client, { schema });
  g.__feeRouterDb = instance;
  return instance;
}

export const db: FeeRouterDb = new Proxy({} as FeeRouterDb, {
  get(_target, prop, receiver) {
    const real = open();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
