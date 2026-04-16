import { EXPECTED_HEADERS } from "./constants";
import type { ImportedHolding } from "./types";

function parseCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];

    if (character === '"') {
      const nextCharacter = line[i + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      columns.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  columns.push(current.trim());
  return columns;
}

function parseNumber(raw: string): number {
  const value = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function mapRowToHolding(columns: string[]): ImportedHolding {
  return {
    account_name: columns[0] ?? "",
    account_type: columns[1] ?? "",
    account_classification: columns[2] ?? "",
    account_number: columns[3] ?? "",
    symbol: columns[4] ?? "",
    exchange: columns[5] ?? "",
    mic: columns[6] ?? "",
    name: columns[7] ?? "",
    security_type: columns[8] ?? "",
    quantity: parseNumber(columns[9] ?? "0"),
    position_direction: columns[10] ?? "",
    market_price: parseNumber(columns[11] ?? "0"),
    market_price_currency: columns[12] ?? "",
    book_value_cad: parseNumber(columns[13] ?? "0"),
    book_value_currency_cad: columns[14] ?? "",
    book_value_market: parseNumber(columns[15] ?? "0"),
    book_value_currency_market: columns[16] ?? "",
    market_value: parseNumber(columns[17] ?? "0"),
    market_value_currency: columns[18] ?? "",
    market_unrealized_returns: parseNumber(columns[19] ?? "0"),
    market_unrealized_returns_currency: columns[20] ?? "",
  };
}

export function parseHoldingsCsv(csvText: string): {
  holdings: ImportedHolding[];
  asOf: string | null;
} {
  const lines = csvText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new Error(
      "CSV appears empty. Please upload a file with a header and at least one holding.",
    );
  }

  const headers = parseCsvLine(lines[0]);
  const missingHeaders = EXPECTED_HEADERS.filter(
    (header) => !headers.includes(header),
  );
  if (missingHeaders.length > 0) {
    throw new Error(
      `CSV format mismatch. Missing headers: ${missingHeaders.join(", ")}`,
    );
  }

  const holdings: ImportedHolding[] = [];
  let asOf: string | null = null;

  for (let i = 1; i < lines.length; i += 1) {
    const columns = parseCsvLine(lines[i]);
    const firstCell = columns[0]?.replace(/^"|"$/g, "").trim() ?? "";

    if (firstCell.toLowerCase().startsWith("as of")) {
      asOf = firstCell;
      continue;
    }

    if (columns.length < EXPECTED_HEADERS.length) {
      continue;
    }

    holdings.push(mapRowToHolding(columns));
  }

  if (holdings.length === 0) {
    throw new Error("No holdings rows were detected in the CSV.");
  }

  return { holdings, asOf };
}
