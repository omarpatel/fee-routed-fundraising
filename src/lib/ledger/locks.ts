/**
 * Per-process mutex keyed by delivery or vault id. The API routes and the embedded worker share one
 * Node process, so serialising money-moving sections here removes the in-process race; the atomic
 * status claims in the ledger remain the cross-process guard.
 */
const chains = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  chains.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === chained) chains.delete(key);
  }
}
