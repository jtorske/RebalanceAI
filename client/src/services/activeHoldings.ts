import { DEMO_HOLDINGS } from "../lib/demoHoldings";
import type { ImportedHolding } from "../lib/types";
import { getHoldings } from "./holdingsService";

export async function loadActiveHoldings({
  portfolioId,
  isDemoMode,
}: {
  portfolioId: string | null | undefined;
  isDemoMode: boolean;
}): Promise<ImportedHolding[]> {
  if (portfolioId) {
    return getHoldings(portfolioId);
  }

  if (isDemoMode) {
    return DEMO_HOLDINGS;
  }

  return [];
}
