export const tickerLogoMap: Record<string, string> = {};

export function getTickerLogoUrl(symbol: string): string | null {
  return tickerLogoMap[symbol.toUpperCase()] ?? null;
}
