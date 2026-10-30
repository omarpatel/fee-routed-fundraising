import { createClient } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import * as schema from "../src/lib/db/schema";

/**
 * Once per run: build an empty ledger with the current schema in a temp dir. Each test file copies
 * it (see `tests/setup.ts`), so tests never share state and never touch `data/fee-router.db`.
 * Teardown asserts the real database's mtime did not move during the run.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(path.join(tmpdir(), "fee-router-tests-"));
  const template = path.join(dir, "template.db");
  const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema));
  const client = createClient({ url: `file:${template}` });
  for (const s of statements) await client.execute(s);
  client.close();
  project.provide("feeRouterTestDir", dir);

  const realDb = path.resolve(project.config.root, "data", "fee-router.db");
  const before = mtime(realDb);
  return () => {
    // Worker processes may still hold libsql handles for a moment on Windows; leftovers in tmp are harmless.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
    const after = mtime(realDb);
    if (before !== after) throw new Error(`Tests modified ${realDb} (mtime ${before} -> ${after}); every DB test must use its own temp database`);
  };
}

function mtime(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    feeRouterTestDir: string;
  }
}
