import { ok, requireApiSession, route } from "@/app/api/_lib";
import { recentTransfers, walletBalances, WalletError, type WalletBalances } from "@/lib/wallet";

/**
 * The signed-in user's custodial wallet: address, balances and recent outflows.
 * Without SOLANA_RPC_URL the balances are null and `balancesError` says why; address and
 * transfers still come back so the card can render the deposit side.
 */
export const GET = route(async () => {
  const { user } = await requireApiSession();
  const address = user.walletAddress;
  let balances: WalletBalances | null = null;
  let balancesError: string | null = null;
  const [balancesResult, transfers] = await Promise.all([walletBalances(address).catch((e: unknown) => e), recentTransfers(user.id)]);
  if (balancesResult instanceof WalletError) balancesError = balancesResult.message;
  else if (balancesResult instanceof Error) balancesError = `RPC error: ${balancesResult.message}`;
  else balances = balancesResult as WalletBalances;
  return ok({ address, balances, balancesError, transfers });
});
