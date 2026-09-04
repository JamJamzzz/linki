import Papa from "papaparse";

// Hard safety net independent of DROPBOX_INTAKE_MAX_ROWS — protects against a producer
// mistakenly writing a huge file before row-count validation even gets a chance to run.
export const MAX_CONTACTS_CSV_BYTES = 10 * 1024 * 1024; // 10 MB

export interface CsvPreflightResult {
  ok: boolean;
  rowCount: number;
  errors: string[];
}

/**
 * Cheap pre-flight check before handing the CSV to lib/csv-import.ts's importCsv (which
 * does the real parsing/dedup/insert). Only checks size and row count — per-row content
 * validation (linkedin_url/email presence, format) is importCsv's job and is NOT
 * duplicated here.
 */
export function preflightContactsCsv(csvText: string, maxRows: number): CsvPreflightResult {
  const errors: string[] = [];
  const byteLength = Buffer.byteLength(csvText, "utf8");
  if (byteLength > MAX_CONTACTS_CSV_BYTES) {
    errors.push(`contacts.csv is ${byteLength} bytes, exceeding the ${MAX_CONTACTS_CSV_BYTES} byte limit`);
    return { ok: false, rowCount: 0, errors };
  }

  if (!csvText.trim()) {
    errors.push("contacts.csv is empty");
    return { ok: false, rowCount: 0, errors };
  }

  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
  const rowCount = parsed.data.length;

  if (parsed.errors.some((e) => e.type === "Delimiter" || e.type === "Quotes")) {
    errors.push(`contacts.csv is malformed: ${parsed.errors[0].message}`);
    return { ok: false, rowCount, errors };
  }

  if (rowCount === 0) {
    errors.push("contacts.csv has no data rows");
    return { ok: false, rowCount, errors };
  }

  if (rowCount > maxRows) {
    errors.push(`contacts.csv has ${rowCount} rows, exceeding the configured limit of ${maxRows} (DROPBOX_INTAKE_MAX_ROWS)`);
    return { ok: false, rowCount, errors };
  }

  return { ok: true, rowCount, errors };
}
