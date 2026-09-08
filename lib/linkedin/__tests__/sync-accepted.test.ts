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

function seedAccount(db: DB): string {
  const id = randomUUID();
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, 'Test Account', ?, 1)").run(id, `${id}@example.com`);
  return id;
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
 */
function makeFakePage(declaredTotal: number | null, connectionPages: VoyagerConn[][]) {
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
