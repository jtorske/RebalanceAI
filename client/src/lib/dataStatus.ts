const STORAGE_KEY = "rx-data-status";

export type DataStatus = {
  sourceFileName: string | null;
  importedAt: string | null;
  holdingsCount: number;
  fxRate: number;
};

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
