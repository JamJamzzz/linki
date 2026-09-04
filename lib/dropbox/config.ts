// Dropbox intake configuration — read directly from process.env, same convention as
// lib/auth.ts / lib/crypto.ts (no config module, no DB-backed settings). Credentials are
// OAuth refresh-token based (long-lived) rather than a short-lived access token, per the
// app-key/app-secret/refresh-token flow — see lib/dropbox/client.ts for the token exchange.
//
// Disabled (or incompletely configured) is always a safe, silent no-op: the rest of the
// app must keep working normally. Never throw from here.

export interface DropboxIntakeConfig {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  /** Absolute Dropbox path, e.g. "/LinkiInbox". Always starts with "/", never ends with "/". */
  root: string;
  pollIntervalSeconds: number;
  maxRows: number;
}

const DEFAULT_ROOT = "/LinkiInbox";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_ROWS = 500;

// Fixed, non-configurable siblings of the intake root — see README for why these aren't
// environment-configurable (keeping them fixed makes the archive destination predictable
// and easy to reason about for anyone auditing the Dropbox app's folder access).
export const PROCESSED_ROOT = "/LinkiProcessed";
export const FAILED_ROOT = "/LinkiFailed";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Normalizes and validates a configured Dropbox root path. Returns null if unsafe. */
export function normalizeDropboxRoot(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, ""); // strip trailing slash(es)
  if (p === "") return null; // "/" alone is not allowed — never watch the whole Dropbox
  if (p.includes("..") || p.includes("\0")) return null;
  // Reject the fixed archive roots as the intake root — would cause the poller to
  // treat its own processed/failed folders as new batches.
  if (p === PROCESSED_ROOT || p === FAILED_ROOT) return null;
  return p;
}

/**
 * Returns the active config, or null when Dropbox intake is disabled or missing
 * required credentials. Callers must treat null as "do nothing" — never throw.
 */
export function getDropboxIntakeConfig(): DropboxIntakeConfig | null {
  if (process.env.DROPBOX_INTAKE_ENABLED !== "true") return null;

  const appKey = process.env.DROPBOX_APP_KEY?.trim();
  const appSecret = process.env.DROPBOX_APP_SECRET?.trim();
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN?.trim();
  if (!appKey || !appSecret || !refreshToken) return null;

  const root = normalizeDropboxRoot(process.env.DROPBOX_INTAKE_ROOT || DEFAULT_ROOT);
  if (!root) return null;

  return {
    appKey,
    appSecret,
    refreshToken,
    root,
    pollIntervalSeconds: parsePositiveInt(process.env.DROPBOX_INTAKE_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS),
    maxRows: parsePositiveInt(process.env.DROPBOX_INTAKE_MAX_ROWS, DEFAULT_MAX_ROWS),
  };
}
