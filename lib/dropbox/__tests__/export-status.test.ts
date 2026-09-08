import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

vi.mock("@/lib/dropbox/client", async () => await import("./fake-dropbox"));

import * as fake from "./fake-dropbox";
import { DropboxApiError } from "./fake-dropbox";

type DB = DatabaseType.Database;

const STATUS_PATH = "/RecruitingOSInbox/referral/linkedin-status.csv";
const savedEnv = { ...process.env };

let createDatabase: typeof import("@/lib/db").createDatabase;
let exportLinkedinStatusSnapshot: typeof import("@/lib/dropbox/export-status").exportLinkedinStatusSnapshot;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ exportLinkedinStatusSnapshot } = await import("@/lib/dropbox/export-status"));
});

function freshDb(): DB {
  return createDatabase(":memory:");
}

function enableDropboxIntake(): void {
  process.env.DROPBOX_INTAKE_ENABLED = "true";
  process.env.DROPBOX_APP_KEY = "test-key";
  process.env.DROPBOX_APP_SECRET = "test-secret";
  process.env.DROPBOX_REFRESH_TOKEN = "test-refresh";
}

beforeEach(() => {
  process.env = { ...savedEnv };
  fake.__reset();
});

interface TargetOpts {
  linkedin_url: string;
  full_name?: string;
  company?: string;
  connection_requested_at?: string | null;
  connected_at?: string | null;
  degree?: number | null;
}

function seedTarget(db: DB, opts: TargetOpts): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO targets (id, linkedin_url, full_name, company, connection_requested_at, connected_at, degree)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.linkedin_url,
    opts.full_name ?? null,
    opts.company ?? null,
    opts.connection_requested_at ?? null,
    opts.connected_at ?? null,
    opts.degree ?? null
  );
  return id;
}

describe("exportLinkedinStatusSnapshot (Problem 4)", () => {
  it("is a clean no-op when Dropbox intake is disabled", async () => {
    delete process.env.DROPBOX_INTAKE_ENABLED;
    const db = freshDb();
    seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/jane/", connection_requested_at: "2026-01-01 00:00:00" });

    await exportLinkedinStatusSnapshot(db);

    expect(fake.__exists(STATUS_PATH)).toBe(false);
  });

  it("maps degree=1 to CONNECTED and requested-but-unconfirmed to REQUEST_SENT, excluding never-requested targets", async () => {
    enableDropboxIntake();
    const db = freshDb();
    seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/jane-doe/",
      full_name: "Jane Doe",
      company: "Acme",
      connection_requested_at: "2026-01-01 00:00:00",
      connected_at: "2026-01-02 00:00:00",
      degree: 1,
    });
    seedTarget(db, {
      linkedin_url: "https://www.linkedin.com/in/john-smith/",
      full_name: "John Smith",
      connection_requested_at: "2026-01-01 00:00:00",
      degree: null,
    });
    // Never had a connect request sent — must not appear in the export at all.
    seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/never-requested/" });

    await exportLinkedinStatusSnapshot(db);

    const csv = fake.__readFile(STATUS_PATH);
    expect(csv).toBeDefined();
    // Papa.unparse defaults to RFC4180 CRLF line endings — normalize before splitting.
    const lines = csv!.trim().replace(/\r\n/g, "\n").split("\n");
    expect(lines[0]).toBe("linkedin_url,full_name,company,connection_requested_at,connected_at,degree,status,exported_at");
    expect(lines).toHaveLength(3); // header + 2 requested targets
    expect(csv).toMatch(/jane-doe[^\n]*CONNECTED/);
    expect(csv).toMatch(/john-smith[^\n]*REQUEST_SENT/);
    expect(csv).not.toContain("never-requested");
  });

  it("overwrites the snapshot on each call rather than appending", async () => {
    enableDropboxIntake();
    const db = freshDb();
    seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/first/", connection_requested_at: "2026-01-01 00:00:00" });
    await exportLinkedinStatusSnapshot(db);
    const firstLineCount = fake.__readFile(STATUS_PATH)!.trim().split("\n").length;

    seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/second/", connection_requested_at: "2026-01-01 00:00:00" });
    await exportLinkedinStatusSnapshot(db);
    const secondCsv = fake.__readFile(STATUS_PATH)!;

    // header + 2 rows now, not header + 1 + header + 2 appended.
    expect(secondCsv.trim().split("\n")).toHaveLength(firstLineCount + 1);
  });

  it("logs a warning and never throws when the Dropbox upload fails", async () => {
    enableDropboxIntake();
    const db = freshDb();
    seedTarget(db, { linkedin_url: "https://www.linkedin.com/in/jane/", connection_requested_at: "2026-01-01 00:00:00" });
    fake.__queueFailure("uploadText", new DropboxApiError("network down", "network", true));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(exportLinkedinStatusSnapshot(db)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
