export const tickerLogoMap: Record<string, string> = {
  AMD: "/logos/amd.svg",
  ANET: "/logos/anet.svg",
  ETN: "/logos/etn.svg",
};

export function getTickerLogoUrl(symbol: string): string | null {
  return tickerLogoMap[symbol.toUpperCase()] ?? null;
}
