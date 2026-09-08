import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

// syncAcceptedConnections drives a Playwright Page and the shared-session module — mock
// only that narrow boundary, exactly the way the connect-step tests do for connect.ts.
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(),
  saveSessionState: vi.fn(async () => {}),
  markNeedsReauth: vi.fn(async () => {}),
}));

// Avoid any coupling to Dropbox env state from other test files sharing this worker.
vi.mock("@/lib/dropbox/export-status", () => ({
  exportLinkedinStatusSnapshot: vi.fn(async () => {}),
}));

type DB = DatabaseType.Database;

let createDatabase: typeof import("@/lib/db").createDatabase;
let extractLinkedinVanity: typeof import("@/lib/linkedin/sync-accepted").extractLinkedinVanity;
let syncAcceptedConnections: typeof import("@/lib/linkedin/sync-accepted").syncAcceptedConnections;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getSessionPageMock: any;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ extractLinkedinVanity, syncAcceptedConnections } = await import("@/lib/linkedin/sync-accepted"));
  const sessionModule = await import("@/lib/linkedin/session");
  getSessionPageMock = sessionModule.getSessionPage;
});

beforeEach(() => {
  getSessionPageMock.mockReset();
});

function freshDb(): DB {
  return createDatabase(":memory:");
}

/** boundaryMs = accounts.connections_synced_through_ms; null (default) means a FULL pass. */
function seedAccount(db: DB, boundaryMs: number | null = null): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO accounts (id, name, email, is_authenticated, connections_synced_through_ms) VALUES (?, 'Test Account', ?, 1, ?)"
  ).run(id, `${id}@example.com`, boundaryMs);
  return id;
}

function readBoundary(db: DB, accountId: string): number | null {
  return (db.prepare("SELECT connections_synced_through_ms FROM accounts WHERE id = ?").get(accountId) as {
    connections_synced_through_ms: number | null;
  }).connections_synced_through_ms;
}

interface TargetSeed {
  linkedin_url: string;
  full_name?: string;
  connection_requested_at?: string | null;
  degree?: number | null;
  connected_at?: string | null;
}

function seedTarget(db: DB, opts: TargetSeed): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO targets (id, linkedin_url, full_name, connection_requested_at, degree, connected_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.linkedin_url,
    opts.full_name ?? "Test Person",
    opts.connection_requested_at === undefined ? "2026-01-01 00:00:00" : opts.connection_requested_at,
    opts.degree ?? null,
    opts.connected_at ?? null
  );
  return id;
}

function readTarget(db: DB, id: string): { degree: number | null; connected_at: string | null } {
  return db.prepare("SELECT degree, connected_at FROM targets WHERE id = ?").get(id) as {
    degree: number | null;
    connected_at: string | null;
  };
}

interface VoyagerConn { createdAt: number; vanity: string | null }

/**
 * Fake Playwright Page good enough for syncAcceptedConnections: goto/waitForTimeout are
 * no-ops, url() reports a normal (not logged-out) page, and evaluate() replays canned
 * results in call order: [declaredTotal, ...connectionPages, <empty page to end pagination>].
 *
 * A page entry of `null` represents a failed Voyager API call (fetchConnectionsPage
 * returns null); `[]` represents the natural end of the connections list.
 */
function makeFakePage(declaredTotal: number | null, connectionPages: Array<VoyagerConn[] | null>) {
  const results: unknown[] = [declaredTotal, ...connectionPages, []];
  let i = 0;
  return {
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    url: vi.fn(() => "https://www.linkedin.com/mynetwork/invite-connect/connections/"),
    evaluate: vi.fn(async () => results[Math.min(i++, results.length - 1)]),
    close: vi.fn(async () => {}),
  };
}

describe("extractLinkedinVanity (canonical /in/ identity)", () => {
  it.each([
    ["https://www.linkedin.com/in/ahuynher", "ahuynher"],
    ["https://www.linkedin.com/in/ahuynher/", "ahuynher"],
    ["https://www.linkedin.com/in/xiaohan-sun-607153284/en", "xiaohan-sun-607153284"],
    ["https://www.linkedin.com/in/foo?trk=abc", "foo"],
    ["https://www.linkedin.com/in/foo#abc", "foo"],
    ["https://www.linkedin.com/in/FooBar/", "foobar"],
    ["https://linkedin.com/in/foo", "foo"],
    ["https://WWW.LINKEDIN.COM/in/Foo/", "foo"],
  ])("%s => %s", (url, expected) => {
    expect(extractLinkedinVanity(url)).toBe(expected);
  });

  it("returns null for a non-profile URL", () => {
    expect(extractLinkedinVanity("https://www.linkedin.com/company/foo")).toBeNull();
  });

  it("returns null for empty/missing input", () => {
    expect(extractLinkedinVanity(null)).toBeNull();
    expect(extractLinkedinVanity(undefined)).toBeNull();
    expect(extractLinkedinVanity("")).toBeNull();
  });

  it("treats foo and foobar as distinct identities (exact match, not substring)", () => {
    expect(extractLinkedinVanity("https://www.linkedin.com/in/foo/")).not.toBe(
      extractLinkedinVanity("https://www.linkedin.com/in/foobar/")
    );
  });
});

describe("syncAcceptedConnections — vanity matching (root bug: trailing-slash-dependent LIKE)", () => {
  it("stamps a target stored WITHOUT a trailing slash", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/ahuynher" });
    getSessionPageMock.mockResolvedValue(makeFakePage(1, [[{ createdAt: Date.now(), vanity: "ahuynher" }]]));

    const stamped = await syncAcceptedConnections(accountId, db);

    expect(stamped).toBe(1);
    const t = readTarget(db, targetId);
    expect(t.degree).toBe(1);
    expect(t.connected_at).not.toBeNull();
  });

  it("stamps a target stored with a trailing locale segment (/foo/en)", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo/en" });
    getSessionPageMock.mockResolvedValue(makeFakePage(1, [[{ createdAt: Date.now(), vanity: "foo" }]]));

    await syncAcceptedConnections(accountId, db);

    expect(readTarget(db, targetId).degree).toBe(1);
  });

  it("stamps only the exact vanity match — foo does not stamp foobar", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const fooId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo/" });
    const foobarId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foobar/" });
    getSessionPageMock.mockResolvedValue(makeFakePage(2, [[{ createdAt: Date.now(), vanity: "foo" }]]));

    const stamped = await syncAcceptedConnections(accountId, db);

    expect(stamped).toBe(1);
    expect(readTarget(db, fooId).degree).toBe(1);
    expect(readTarget(db, foobarId).degree).toBeNull();
  });

  it("is idempotent for a target already degree=1 with connected_at set", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const targetId = seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/already-connected",
      degree: 1,
      connected_at: "2025-06-01 00:00:00",
    });
    getSessionPageMock.mockResolvedValue(makeFakePage(1, [[{ createdAt: Date.now(), vanity: "already-connected" }]]));

    const stamped = await syncAcceptedConnections(accountId, db);

    expect(stamped).toBe(0);
    expect(readTarget(db, targetId).connected_at).toBe("2025-06-01 00:00:00");
  });

  it("verified full-pass phantom cleanup recognizes a no-trailing-slash stored URL as seen (does not unmark it)", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const targetId = seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/ahuynher",
      degree: 1,
      connected_at: "2025-06-01 00:00:00",
    });
    // declaredTotal matches uniquePulled exactly => verified-complete full pass
    getSessionPageMock.mockResolvedValue(makeFakePage(1, [[{ createdAt: Date.now(), vanity: "ahuynher" }]]));

    await syncAcceptedConnections(accountId, db);

    expect(readTarget(db, targetId).degree).toBe(1);
  });

  it("verified full-pass phantom cleanup still unmarks a target genuinely absent from Voyager", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const phantomId = seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/nolongerconnected",
      degree: 1,
      connected_at: "2025-06-01 00:00:00",
    });
    // declaredTotal=0 and no connections at all => verified-complete empty full pass
    getSessionPageMock.mockResolvedValue(makeFakePage(0, []));

    await syncAcceptedConnections(accountId, db);

    const t = readTarget(db, phantomId);
    expect(t.degree).toBeNull();
    expect(t.connected_at).toBeNull();
  });

  it("verified full-pass phantom cleanup preserves a degree=1 row whose URL has no extractable /in/ vanity", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    // A Sales Navigator (non-/in/) URL — extractLinkedinVanity() intentionally returns
    // null for this, so this row is unverifiable by the vanity-based full pass, not
    // proven phantom. It must be left alone even though its vanity is absent from
    // seenVanities (there is no vanity to look up in the first place).
    const unverifiableId = seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/sales/lead/abc123",
      degree: 1,
      connected_at: "2025-06-01 00:00:00",
    });
    // declaredTotal=0 and no connections at all => verified-complete empty full pass —
    // the same conditions that DO unmark a genuine /in/ phantom in the test above.
    getSessionPageMock.mockResolvedValue(makeFakePage(0, []));

    await syncAcceptedConnections(accountId, db);

    const t = readTarget(db, unverifiableId);
    expect(t.degree).toBe(1);
    expect(t.connected_at).toBe("2025-06-01 00:00:00");
  });
});

describe("syncAcceptedConnections — boundary commit rule (only advance on proven coverage)", () => {
  const HOUR = 60 * 60 * 1000;

  it("TEST 1: an incomplete full pass keeps the NULL boundary, stays add-only, and does not phantom-clean", async () => {
    const db = freshDb();
    const accountId = seedAccount(db); // boundary NULL => FULL pass
    const acceptedId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo" });
    // degree=1 but absent from the (truncated) Voyager results — a verified-complete pass
    // would unmark this; an incomplete one must not.
    const untouchedId = seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/not-in-this-scan",
      degree: 1,
      connected_at: "2025-06-01 00:00:00",
    });
    // Declares 500 connections but the API dies after the first page (1 pulled).
    getSessionPageMock.mockResolvedValue(
      makeFakePage(500, [[{ createdAt: Date.now(), vanity: "foo" }], null])
    );

    await syncAcceptedConnections(accountId, db);

    // Positive evidence from the page that DID succeed is kept (add-only).
    expect(readTarget(db, acceptedId).degree).toBe(1);
    // No destructive phantom cleanup on an unverified pass.
    expect(readTarget(db, untouchedId).degree).toBe(1);
    expect(readTarget(db, untouchedId).connected_at).toBe("2025-06-01 00:00:00");
    // The critical regression: the boundary must stay NULL so the next sync retries FULL.
    expect(readBoundary(db, accountId)).toBeNull();
  });

  it("TEST 2: a checksum-verified complete full pass still advances the boundary", async () => {
    const db = freshDb();
    const accountId = seedAccount(db); // boundary NULL => FULL pass
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo" });
    const newest = Date.now();
    // declaredTotal === uniquePulled => verified complete
    getSessionPageMock.mockResolvedValue(makeFakePage(1, [[{ createdAt: newest, vanity: "foo" }]]));

    await syncAcceptedConnections(accountId, db);

    expect(readTarget(db, targetId).degree).toBe(1);
    expect(readBoundary(db, accountId)).toBe(newest);
  });

  it("TEST 3: an incremental pass that crosses the old boundary's overlap margin advances", async () => {
    const db = freshDb();
    const oldBoundary = Date.now() - 10 * 24 * HOUR;
    const accountId = seedAccount(db, oldBoundary); // non-null => INCREMENTAL
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo" });
    const newest = Date.now();
    // Second entry is older than (oldBoundary - 24h overlap) => coverage proven.
    getSessionPageMock.mockResolvedValue(
      makeFakePage(999, [[
        { createdAt: newest, vanity: "foo" },
        { createdAt: oldBoundary - 25 * HOUR, vanity: "someone-older" },
      ]])
    );

    await syncAcceptedConnections(accountId, db);

    expect(readTarget(db, targetId).degree).toBe(1);
    expect(readBoundary(db, accountId)).toBe(newest);
  });

  it("TEST 4: an incremental pass that fails before reaching the overlap region keeps the OLD boundary", async () => {
    const db = freshDb();
    const oldBoundary = Date.now() - 10 * 24 * HOUR;
    const accountId = seedAccount(db, oldBoundary); // non-null => INCREMENTAL
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo" });
    const newest = Date.now();
    // One good page (still newer than the overlap region), then the API fails.
    getSessionPageMock.mockResolvedValue(
      makeFakePage(999, [[{ createdAt: newest, vanity: "foo" }], null])
    );

    await syncAcceptedConnections(accountId, db);

    // Add-only: the accept we did prove is kept...
    expect(readTarget(db, targetId).degree).toBe(1);
    // ...but the unscanned region must be retried, so the boundary must NOT move.
    expect(readBoundary(db, accountId)).toBe(oldBoundary);
  });

  it("TEST 5: an incremental pass that reaches the natural end of the list advances", async () => {
    const db = freshDb();
    const oldBoundary = Date.now() - 10 * 24 * HOUR;
    const accountId = seedAccount(db, oldBoundary); // non-null => INCREMENTAL
    const targetId = seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/foo" });
    const newest = Date.now();
    // Never crosses the overlap margin, but the list genuinely ends (trailing []).
    getSessionPageMock.mockResolvedValue(makeFakePage(999, [[{ createdAt: newest, vanity: "foo" }]]));

    await syncAcceptedConnections(accountId, db);

    expect(readTarget(db, targetId).degree).toBe(1);
    expect(readBoundary(db, accountId)).toBe(newest);
  });
});
