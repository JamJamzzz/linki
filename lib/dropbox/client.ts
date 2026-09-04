// Minimal Dropbox REST client built on global fetch (Node 18+) — no SDK dependency, since
// intake only needs list_folder(_continue), download, move_v2 and create_folder_v2.
//
// Auth: exchanges the long-lived refresh token for a short-lived access token on demand
// (OAuth2 refresh_token grant) and caches it in-memory until shortly before it expires.
// Never logs the refresh token, access token, or Authorization header.

import type { DropboxIntakeConfig } from "@/lib/dropbox/config";

export type DropboxErrorKind = "auth" | "rate_limit" | "network" | "not_found" | "conflict" | "other";

export class DropboxApiError extends Error {
  readonly kind: DropboxErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, kind: DropboxErrorKind, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "DropboxApiError";
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface DropboxEntry {
  tag: "file" | "folder" | "deleted";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  rev?: string;
  content_hash?: string;
  size?: number;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Keyed by appKey+refreshToken so multiple configs (tests) don't share a cache.
const tokenCache = new Map<string, TokenCache>();

function cacheKey(config: DropboxIntakeConfig): string {
  return `${config.appKey}:${config.refreshToken}`;
}

async function getAccessToken(config: DropboxIntakeConfig): Promise<string> {
  const key = cacheKey(config);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt - now > 60_000) return cached.accessToken;

  let res: Response;
  try {
    res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
        client_id: config.appKey,
        client_secret: config.appSecret,
      }),
    });
  } catch {
    throw new DropboxApiError("Network error while refreshing Dropbox access token", "network", true);
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new DropboxApiError(
      `Dropbox token refresh failed (${res.status})`,
      res.status === 429 ? "rate_limit" : retryable ? "network" : "auth",
      retryable,
      parseRetryAfter(res)
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  const token: TokenCache = { accessToken: json.access_token, expiresAt: now + json.expires_in * 1000 };
  tokenCache.set(key, token);
  return token.accessToken;
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = parseInt(h, 10);
  return Number.isFinite(n) ? n * 1000 : undefined;
}

async function classifyErrorResponse(res: Response): Promise<DropboxApiError> {
  let bodyText = "";
  try { bodyText = await res.text(); } catch { /* ignore */ }
  // Dropbox conflict errors (e.g. folder already exists on create) are structured JSON —
  // detect the common "already exists" shape so callers can treat it as a no-op.
  const isConflict = res.status === 409;
  if (res.status === 401) return new DropboxApiError("Dropbox authentication failed (invalid/expired token)", "auth", false);
  if (res.status === 429) return new DropboxApiError("Dropbox rate limit exceeded", "rate_limit", true, parseRetryAfter(res));
  if (res.status >= 500) return new DropboxApiError(`Dropbox server error (${res.status})`, "network", true);
  if (res.status === 404) return new DropboxApiError("Dropbox path not found", "not_found", false);
  if (isConflict) return new DropboxApiError(`Dropbox conflict: ${bodyText.slice(0, 300)}`, "conflict", false);
  return new DropboxApiError(`Dropbox API error (${res.status}): ${bodyText.slice(0, 300)}`, "other", false);
}

async function rpc<T>(config: DropboxIntakeConfig, endpoint: string, body: unknown): Promise<T> {
  const token = await getAccessToken(config);
  let res: Response;
  try {
    res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DropboxApiError(`Network error calling ${endpoint}`, "network", true);
  }
  if (!res.ok) throw await classifyErrorResponse(res);
  return (await res.json()) as T;
}

function toEntry(raw: { ".tag": string; name: string; path_lower: string; path_display: string; id: string; rev?: string; content_hash?: string; size?: number }): DropboxEntry {
  return {
    tag: raw[".tag"] as DropboxEntry["tag"],
    name: raw.name,
    path_lower: raw.path_lower,
    path_display: raw.path_display,
    id: raw.id,
    rev: raw.rev,
    content_hash: raw.content_hash,
    size: raw.size,
  };
}

/** Lists the direct (non-recursive) children of a folder. Handles pagination internally. */
export async function listFolder(config: DropboxIntakeConfig, path: string): Promise<DropboxEntry[]> {
  type RawEntry = Parameters<typeof toEntry>[0];
  type ListResult = { entries: RawEntry[]; cursor: string; has_more: boolean };

  // Dropbox treats the root of the app/account as "" not "/".
  const dbxPath = path === "/" ? "" : path;
  let result: ListResult;
  try {
    result = await rpc<ListResult>(config, "files/list_folder", {
      path: dbxPath,
      recursive: false,
      include_deleted: false,
    });
  } catch (err) {
    if (err instanceof DropboxApiError && err.kind === "not_found") return [];
    throw err;
  }

  const entries = result.entries.map(toEntry);
  let cursor = result.cursor;
  let hasMore = result.has_more;
  while (hasMore) {
    const cont = await rpc<ListResult>(config, "files/list_folder/continue", { cursor });
    entries.push(...cont.entries.map(toEntry));
    cursor = cont.cursor;
    hasMore = cont.has_more;
  }
  return entries.filter((e) => e.tag !== "deleted");
}

/** Downloads a file's content as UTF-8 text. */
export async function downloadText(config: DropboxIntakeConfig, path: string): Promise<string> {
  const token = await getAccessToken(config);
  let res: Response;
  try {
    res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path }),
      },
    });
  } catch {
    throw new DropboxApiError(`Network error downloading ${path}`, "network", true);
  }
  if (!res.ok) throw await classifyErrorResponse(res);
  return await res.text();
}

/** Uploads (creates/overwrites) a small text file. Best-effort caller decides how to handle failure. */
export async function uploadText(config: DropboxIntakeConfig, path: string, content: string): Promise<void> {
  const token = await getAccessToken(config);
  let res: Response;
  try {
    res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }),
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });
  } catch {
    throw new DropboxApiError(`Network error uploading ${path}`, "network", true);
  }
  if (!res.ok) throw await classifyErrorResponse(res);
}

/** Creates a folder if it doesn't already exist. Idempotent — swallows the "already exists" conflict. */
export async function ensureFolder(config: DropboxIntakeConfig, path: string): Promise<void> {
  try {
    await rpc(config, "files/create_folder_v2", { path, autorename: false });
  } catch (err) {
    if (err instanceof DropboxApiError && err.kind === "conflict") return; // already exists
    throw err;
  }
}

/** Moves a file/folder. Ensures the destination's parent folder exists first. */
export async function movePath(config: DropboxIntakeConfig, fromPath: string, toPath: string): Promise<void> {
  await rpc(config, "files/move_v2", { from_path: fromPath, to_path: toPath, autorename: false });
}
