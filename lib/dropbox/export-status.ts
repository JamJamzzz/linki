import type DatabaseType from "better-sqlite3";
import Papa from "papaparse";
import { getDropboxIntakeConfig } from "@/lib/dropbox/config";
import { ensureFolder, uploadText } from "@/lib/dropbox/client";

type DB = DatabaseType.Database;

// Lightweight positive-feedback channel for the external referral scheduler, which keeps
// its own persistent state under /RecruitingOSInbox/referral/ — a sibling of Linki's own
// _READY intake root, not part of that contract. Linki is NOT the recruiting database:
// this only ever writes a small status snapshot, never imports the scheduler's own
// company-pool/contacts CSVs into Linki's schema.
//
// Reuses the exact same Dropbox app/credentials as intake (lib/dropbox/config.ts,
// lib/dropbox/client.ts) — no second credential system, no new env var. Gated on the same
// DROPBOX_INTAKE_ENABLED switch: if intake is off or unconfigured, this is a silent no-op.
const STATUS_EXPORT_DIR = "/RecruitingOSInbox/referral";
const STATUS_EXPORT_PATH = `${STATUS_EXPORT_DIR}/linkedin-status.csv`;
const CSV_HEADER = [
  "linkedin_url",
  "full_name",
  "company",
  "connection_requested_at",
  "connected_at",
  "degree",
  "status",
  "exported_at",
] as const;

interface StatusRow {
  linkedin_url: string;
  full_name: string | null;
  company: string | null;
  connection_requested_at: string;
  connected_at: string | null;
  degree: number | null;
}

/**
 * Overwrites /RecruitingOSInbox/referral/linkedin-status.csv with a snapshot of every
 * target Linki has actually sent a connection request to (exact /in/ URL required).
 *
 * Status is CONNECTED only when Linki's authoritative sync (lib/linkedin/sync-accepted.ts)
 * has stamped degree = 1; everything else is REQUEST_SENT — that means "a request was
 * sent and Linki hasn't positively confirmed a connection," NOT "definitely still pending".
 *
 * Best-effort and non-fatal by design: a failure here (Dropbox auth/network trouble, or
 * the referral app's Dropbox connection lacking access to this sibling path) is logged as
 * a warning and otherwise swallowed — it must never affect accepted-connection sync, the
 * runner, or outbound connection sending. Skips cleanly if Dropbox intake is disabled or
 * unconfigured.
 */
export async function exportLinkedinStatusSnapshot(db: DB): Promise<void> {
  const config = getDropboxIntakeConfig();
  if (!config) return;

  try {
    const rows = db.prepare(
      `SELECT linkedin_url, full_name, company, connection_requested_at, connected_at, degree
       FROM targets
       WHERE linkedin_url LIKE '%/in/%' AND connection_requested_at IS NOT NULL`
    ).all() as StatusRow[];

    const exportedAt = new Date().toISOString();
    const data = rows.map((r) => [
      r.linkedin_url,
      r.full_name ?? "",
      r.company ?? "",
      r.connection_requested_at,
      r.connected_at ?? "",
      r.degree ?? "",
      r.degree === 1 ? "CONNECTED" : "REQUEST_SENT",
      exportedAt,
    ]);
    const csv = Papa.unparse({ fields: [...CSV_HEADER], data });

    await ensureFolder(config, STATUS_EXPORT_DIR).catch(() => {});
    await uploadText(config, STATUS_EXPORT_PATH, csv);
    console.log(`[dropbox-status-export] wrote ${rows.length} row(s) to ${STATUS_EXPORT_PATH}`);
  } catch (err) {
    console.warn(
      `[dropbox-status-export] failed to write ${STATUS_EXPORT_PATH} (the referral app's Dropbox connection may lack access to this path): ${err instanceof Error ? err.message : err}`
    );
  }
}
