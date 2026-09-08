import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type DatabaseType from "better-sqlite3";

vi.mock("@/lib/linkedin/sync-accepted", () => ({
  shouldSyncAccepted: vi.fn(),
  syncAcceptedConnections: vi.fn(async () => 0),
}));

type DB = DatabaseType.Database;

let createDatabase: typeof import("@/lib/db").createDatabase;
let runAcceptedSyncMaintenance: typeof import("@/lib/linkedin/runner").runAcceptedSyncMaintenance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let shouldSyncAcceptedMock: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let syncAcceptedConnectionsMock: any;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ runAcceptedSyncMaintenance } = await import("@/lib/linkedin/runner"));
  const syncModule = await import("@/lib/linkedin/sync-accepted");
  shouldSyncAcceptedMock = syncModule.shouldSyncAccepted;
  syncAcceptedConnectionsMock = syncModule.syncAcceptedConnections;
});

beforeEach(() => {
  shouldSyncAcceptedMock.mockReset();
  syncAcceptedConnectionsMock.mockReset();
  syncAcceptedConnectionsMock.mockResolvedValue(0);
});

function freshDb(): DB {
  return createDatabase(":memory:");
}

function seedAccount(db: DB, isAuthenticated: 0 | 1 = 1): string {
  const id = randomUUID();
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, 'Test Account', ?, ?)").run(
    id,
    `${id}@example.com`,
    isAuthenticated
  );
  return id;
}

describe("runAcceptedSyncMaintenance (Problem 1: accepted sync independent of active runs)", () => {
  it("runs accepted sync for an authenticated account with zero active runs", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    shouldSyncAcceptedMock.mockReturnValue(true);

    await runAcceptedSyncMaintenance(db);

    expect(shouldSyncAcceptedMock).toHaveBeenCalledWith(accountId, db);
    expect(syncAcceptedConnectionsMock).toHaveBeenCalledWith(accountId, db);
  });

  it("still runs accepted sync when a campaign is active for that account", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = randomUUID();
    db.prepare("INSERT INTO workflows (id, name) VALUES (?, 'Test Workflow')").run(workflowId);
    db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, ?, ?, 'running')").run(
      randomUUID(),
      workflowId,
      accountId
    );
    shouldSyncAcceptedMock.mockReturnValue(true);

    await runAcceptedSyncMaintenance(db);

    expect(syncAcceptedConnectionsMock).toHaveBeenCalledWith(accountId, db);
  });

  it("does not call syncAcceptedConnections when shouldSyncAccepted says it isn't due yet", async () => {
    const db = freshDb();
    seedAccount(db);
    shouldSyncAcceptedMock.mockReturnValue(false);

    await runAcceptedSyncMaintenance(db);

    expect(syncAcceptedConnectionsMock).not.toHaveBeenCalled();
  });

  it("skips unauthenticated accounts entirely", async () => {
    const db = freshDb();
    seedAccount(db, 0);
    shouldSyncAcceptedMock.mockReturnValue(true);

    await runAcceptedSyncMaintenance(db);

    expect(shouldSyncAcceptedMock).not.toHaveBeenCalled();
    expect(syncAcceptedConnectionsMock).not.toHaveBeenCalled();
  });
});

describe("global runner no longer auto-enrolls from all lists (Problem 2)", () => {
  it("lib/personal-auto.ts has been removed", () => {
    expect(fs.existsSync(path.join(process.cwd(), "lib/personal-auto.ts"))).toBe(false);
  });

  it("the global runner source no longer references the old all-list auto-enroller", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/linkedin/runner.ts"), "utf8");
    expect(source).not.toContain("personal-auto");
    expect(source).not.toContain("runPersonalAutoEnroll");
  });
});
