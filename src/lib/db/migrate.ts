import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";
import { db } from "./index";

/**
 * Apply committed SQL migrations (`drizzle/`) at process start. Idempotent: drizzle records applied
 * migrations in `__drizzle_migrations`. This is how the production volume gets its schema; local
 * dev may also use `pnpm db:push`.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
}
