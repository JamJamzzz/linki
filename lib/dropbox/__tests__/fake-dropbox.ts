// In-memory stand-in for lib/dropbox/client.ts, used via vi.mock so intake tests never
// touch a real Dropbox account. Mirrors the real client's contract closely enough for
// testing: list_folder returns only direct children, downloading a missing file throws
// "not_found", moving a missing source throws "not_found" (so archive-retry-after-crash
// logic gets exercised the same way it would against the real API).
//
// Dropbox path identity is case-insensitive (path_lower), but file/folder *names* preserve
// their original case (e.g. "_READY") — the store key is lowercased, the displayed name
// is not, matching that split.

export class DropboxApiError extends Error {
  readonly kind: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(message: string, kind: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "DropboxApiError";
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

interface FakeEntry {
  tag: "file" | "folder";
  content?: string;
  /** Original-case path, e.g. "/LinkiInbox/batch-1/_READY". */
  originalPath: string;
}

let store = new Map<string, FakeEntry>();
let queuedFailures: Array<{ fn: string; error: DropboxApiError }> = [];

function key(p: string): string {
  const lower = p.toLowerCase().replace(/\/+$/, "");
  return lower === "" ? "/" : lower;
}

function stripTrailingSlash(p: string): string {
  const s = p.replace(/\/+$/, "");
  return s === "" ? "/" : s;
}

function maybeThrow(fn: string) {
  const idx = queuedFailures.findIndex((f) => f.fn === fn);
  if (idx >= 0) {
    const [f] = queuedFailures.splice(idx, 1);
    throw f.error;
  }
}

export function __reset(): void {
  store = new Map();
  queuedFailures = [];
}

export function __addFolder(p: string): void {
  store.set(key(p), { tag: "folder", originalPath: stripTrailingSlash(p) });
}

export function __addFile(p: string, content: string): void {
  store.set(key(p), { tag: "file", content, originalPath: stripTrailingSlash(p) });
}

export function __exists(p: string): boolean {
  return store.has(key(p));
}

export function __readFile(p: string): string | undefined {
  return store.get(key(p))?.content;
}

/** Makes the next call to the named fake fn throw the given error once. */
export function __queueFailure(fn: string, error: DropboxApiError): void {
  queuedFailures.push({ fn, error });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listFolder(_config: any, path: string) {
  maybeThrow("listFolder");
  const base = key(path);
  if (base !== "/" && !store.has(base)) return [];
  const prefix = base === "/" ? "" : base;
  const results = [];
  for (const [k, entry] of store.entries()) {
    if (k === base) continue;
    if (!k.startsWith(prefix + "/")) continue;
    const restKey = k.slice((prefix + "/").length);
    if (restKey.includes("/")) continue; // only direct children
    const name = entry.originalPath.split("/").pop()!;
    results.push({
      tag: entry.tag,
      name,
      path_lower: k,
      path_display: entry.originalPath,
      id: "id:" + k,
      content_hash: entry.content ? String(entry.content.length) : undefined,
      size: entry.content?.length,
    });
  }
  return results;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function downloadText(_config: any, path: string): Promise<string> {
  maybeThrow("downloadText");
  const entry = store.get(key(path));
  if (!entry || entry.tag !== "file") throw new DropboxApiError(`not found: ${path}`, "not_found", false);
  return entry.content ?? "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function uploadText(_config: any, path: string, content: string): Promise<void> {
  maybeThrow("uploadText");
  store.set(key(path), { tag: "file", content, originalPath: stripTrailingSlash(path) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureFolder(_config: any, path: string): Promise<void> {
  maybeThrow("ensureFolder");
  const k = key(path);
  if (!store.has(k)) store.set(k, { tag: "folder", originalPath: stripTrailingSlash(path) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function movePath(_config: any, fromPath: string, toPath: string): Promise<void> {
  maybeThrow("movePath");
  const from = key(fromPath);
  const to = key(toPath);
  if (!store.has(from)) throw new DropboxApiError(`source not found: ${fromPath}`, "not_found", false);
  const toDisplay = stripTrailingSlash(toPath);
  const toMove = [...store.entries()].filter(([k]) => k === from || k.startsWith(from + "/"));
  for (const [k, entry] of toMove) {
    const newKey = to + k.slice(from.length);
    const newOriginalPath = toDisplay + entry.originalPath.slice(entry.originalPath.length - (k.length - from.length));
    store.set(newKey, { ...entry, originalPath: newOriginalPath });
    store.delete(k);
  }
}
