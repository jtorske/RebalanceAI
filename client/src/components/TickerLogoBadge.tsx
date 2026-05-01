import { useEffect, useState } from "react";
import { getTickerLogoUrl } from "../lib/tickerLogoMap";

interface Props {
  symbol: string;
  logoUrl?: string | null;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function TickerLogoBadge({ symbol, logoUrl, color, className, style }: Props) {
  const resolvedUrl = logoUrl ?? getTickerLogoUrl(symbol);
  const [imgFailed, setImgFailed] = useState(false);
  const showLogo = !!resolvedUrl && !imgFailed;
  const label = symbol.trim().toUpperCase();
  const fallbackText = label.slice(0, 4) || "?";

  useEffect(() => {
    setImgFailed(false);
  }, [resolvedUrl]);

  return (
    <span
      className={className}
      style={{
        ...style,
        backgroundColor: showLogo ? "#fff" : color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: showLogo ? "inset 0 0 0 1.5px rgba(0,0,0,0.09)" : "none",
      }}
    >
      {showLogo ? (
        <img
          src={resolvedUrl}
          alt={`${label} logo`}
          loading="lazy"
          style={{ width: "62%", height: "62%", objectFit: "contain", display: "block" }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        fallbackText
      )}
    </span>
  );
}
