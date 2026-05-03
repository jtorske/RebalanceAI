export const MASKED_MONEY = "••••";

export function maskSensitiveAmount<T extends string>(
  value: T,
  hideDollarAmounts: boolean,
): T | typeof MASKED_MONEY {
  return hideDollarAmounts ? MASKED_MONEY : value;
}

export function maskSensitiveText(
  value: string,
  hideDollarAmounts: boolean,
): string {
  if (!hideDollarAmounts) return value;

  return value
    .replace(/CA\$[\d.,]+[kKmMbBtT]?/g, MASKED_MONEY)
    .replace(/\$[\d.,]+[kKmMbBtT]?/g, MASKED_MONEY);
}

export function formatMoney(
  value: number | null | undefined,
  {
    currency = "CAD",
    hideDollarAmounts = false,
    maximumFractionDigits = 0,
    minimumFractionDigits = 0,
  }: {
    currency?: string;
    hideDollarAmounts?: boolean;
    maximumFractionDigits?: number;
    minimumFractionDigits?: number;
  } = {},
): string {
  if (hideDollarAmounts) return MASKED_MONEY;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }

  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits,
    minimumFractionDigits,
  }).format(value);
}
