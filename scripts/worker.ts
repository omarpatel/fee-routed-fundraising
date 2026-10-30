/**
 * Standalone worker for local runs: `pnpm worker`. In production the same loop is embedded in the
 * Next.js server (src/instrumentation.ts). Ctrl-C exits cleanly.
 */
import { startWorkerLoop } from "../src/lib/worker";

const loop = startWorkerLoop();
const stop = () => {
  loop.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
