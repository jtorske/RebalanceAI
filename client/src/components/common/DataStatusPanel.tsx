import { useEffect, useState } from "react";
import { readDataStatus, type DataStatus } from "../../lib/dataStatus";
import "./DataStatusPanel.css";

type Props = {
  override?: Partial<DataStatus>;
};

function formatImportedAt(iso: string | null): string {
  if (!iso) return "Unknown";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function DataStatusPanel({ override }: Props) {
  const [status, setStatus] = useState<DataStatus | null>(() => readDataStatus());

  useEffect(() => {
    const handler = () => setStatus(readDataStatus());
    window.addEventListener("rx-data-status-changed", handler);
    return () => window.removeEventListener("rx-data-status-changed", handler);
  }, []);

  const merged: DataStatus | null = status
    ? { ...status, ...override }
    : override
      ? ({ sourceFileName: null, importedAt: null, holdingsCount: 0, fxRate: 1.37, ...override } as DataStatus)
      : null;

  if (!merged || (merged.holdingsCount === 0 && !merged.sourceFileName)) {
    return null;
  }

  return (
    <div className="dsp-row" aria-label="Data status">
      <span className="dsp-label">Data status</span>
      <div className="dsp-items">
        {merged.sourceFileName && (
          <span className="dsp-item">
            <span className="dsp-item-label">Source</span>
            {merged.sourceFileName}
          </span>
        )}
        <span className="dsp-item">
          <span className="dsp-item-label">Imported</span>
          {formatImportedAt(merged.importedAt)}
        </span>
        <span className="dsp-item">
          <span className="dsp-item-label">FX rate</span>
          1 USD = {merged.fxRate.toFixed(2)} CAD
        </span>
        {merged.holdingsCount > 0 && (
          <span className="dsp-item">
            <span className="dsp-item-label">Holdings</span>
            {merged.holdingsCount}
          </span>
        )}
      </div>
    </div>
  );
}
