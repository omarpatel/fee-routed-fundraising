/**
 * Next.js instrumentation hook: runs once per server process. Starts the embedded worker so
 * production needs a single service with a single SQLite writer. Set FEE_ROUTER_EMBEDDED_WORKER=0 to
 * run the worker separately (`pnpm worker`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  if (process.env.FEE_ROUTER_EMBEDDED_WORKER === "0") return;
  const { startWorkerLoop } = await import("@/lib/worker");
  startWorkerLoop();
}
