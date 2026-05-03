const STORAGE_KEY = "rx-data-status";

export type DataStatus = {
  sourceFileName: string | null;
  importedAt: string | null;
  holdingsCount: number;
  fxRate: number;
  missingDataCount?: number;
  warningCount?: number;
};

export type DataQualityStatus = {
  label: "High" | "Medium" | "Low";
  reason: string;
};

export function calculateDataQualityStatus({
  holdingsCount,
  importedAt,
  fxRate,
  missingDataCount,
  warningCount,
}: {
  holdingsCount: number;
  importedAt: string | null;
  fxRate: number | null | undefined;
  missingDataCount?: number;
  warningCount?: number;
}): DataQualityStatus {
  const warnings = (missingDataCount ?? 0) + (warningCount ?? 0);
  const hasHoldings = holdingsCount > 0;
  const hasImportedAt = Boolean(importedAt);
  const hasFxRate = typeof fxRate === "number" && Number.isFinite(fxRate) && fxRate > 0;

  if (!hasHoldings) {
    return {
      label: "Low",
      reason: "Data quality reflects freshness, completeness, and available market data. No holdings are available yet.",
    };
  }

  if (!hasImportedAt || !hasFxRate || warnings >= 5) {
    return {
      label: "Low",
      reason: "Data quality reflects freshness, completeness, and available market data. Key metadata or market data is missing.",
    };
  }

  if (warnings > 0) {
    return {
      label: "Medium",
      reason: "Data quality reflects freshness, completeness, and available market data. Some holdings may need review.",
    };
  }

  return {
    label: "High",
    reason: "Data quality reflects freshness, completeness, and available market data.",
  };
}

export function saveDataStatus(status: DataStatus): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(status));
    window.dispatchEvent(new Event("rx-data-status-changed"));
  } catch {
    // sessionStorage unavailable — ignore
  }
}

export function readDataStatus(): DataStatus | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DataStatus;
  } catch {
    return null;
  }
}
