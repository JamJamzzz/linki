import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

// startRun() calls ensureGlobalRunnerStarted(), which would otherwise spin up the real
// infinite global loop against the real (non-test) DB file. lib/runs.ts imports nothing
// else from this module, so a full stub is enough.
vi.mock("@/lib/linkedin/runner", () => ({ ensureGlobalRunnerStarted: vi.fn() }));

type DB = DatabaseType.Database;

let createDatabase: typeof import("@/lib/db").createDatabase;
let createRun: typeof import("@/lib/runs").createRun;
let startRun: typeof import("@/lib/runs").startRun;
let isFireAndForgetWorkflow: typeof import("@/lib/runs").isFireAndForgetWorkflow;
let activateFireAndForgetRunImmediately: typeof import("@/lib/runs").activateFireAndForgetRunImmediately;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ createRun, startRun, isFireAndForgetWorkflow, activateFireAndForgetRunImmediately } = await import("@/lib/runs"));
});

function freshDb(): DB {
  return createDatabase(":memory:");
}

function seedAccount(db: DB): string {
  const id = randomUUID();
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, 'Test Account', ?, 1)").run(id, `${id}@example.com`);
  return id;
}

interface StepSpec { step_type: string; track?: "linkedin" | "email" }

function seedWorkflow(db: DB, steps: StepSpec[]): string {
  const workflowId = randomUUID();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, 'Test Workflow')").run(workflowId);
  const byTrack = new Map<string, number>();
  for (const s of steps) {
    const track = s.track ?? "linkedin";
    const order = (byTrack.get(track) ?? 0) + 1;
    byTrack.set(track, order);
    if (track === "email") {
      db.prepare(
        "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, email_subject, email_body) VALUES (?, ?, ?, ?, 'email', 'Hi', 'Body')"
      ).run(randomUUID(), workflowId, order, s.step_type);
    } else {
      db.prepare(
        "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES (?, ?, ?, ?, 'linkedin')"
      ).run(randomUUID(), workflowId, order, s.step_type);
    }
  }
  return workflowId;
}

function seedTarget(db: DB): string {
  const id = randomUUID();
  db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, 'Test Person')").run(
    id,
    `https://www.linkedin.com/in/test-${id}/`
  );
  return id;
}

/** Creates a list containing exactly the given target ids (new targets if none given). */
function seedList(db: DB, targetIds?: string[]): { listId: string; targetIds: string[] } {
  const listId = randomUUID();
  db.prepare("INSERT INTO lists (id, name) VALUES (?, 'Test List')").run(listId);
  const ids = targetIds ?? [seedTarget(db)];
  for (const tid of ids) {
    db.prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(listId, tid);
  }
  return { listId, targetIds: ids };
}

describe("isFireAndForgetWorkflow", () => {
  it("connect-only workflow: true", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(true);
  });

  it("visit -> connect: true", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "visit" }, { step_type: "connect" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(true);
  });

  it("connect -> message: false", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }, { step_type: "message" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(false);
  });

  it("connect + separate email track: false", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }, { step_type: "email", track: "email" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(false);
  });

  it("connect -> sales_inmail: false", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }, { step_type: "sales_inmail" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(false);
  });

  it("no connect step at all: false", () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db, [{ step_type: "visit" }, { step_type: "delay" }]);
    expect(isFireAndForgetWorkflow(db, workflowId)).toBe(false);
  });
});

/** createRun() only ever inserts a run as 'pending' — startRun() is what flips it to
 * 'running'. The one-active-run guard keys off status IN ('running','paused'), so tests
 * exercising that guard must simulate an actually-started first run. */
function markRunning(db: DB, runId: string): void {
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
}

describe("createRun — fire-and-forget concurrency (Problem 2)", () => {
  it("allows a second run of the same connect-only workflow while the first is still running", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const listA = seedList(db);
    const listB = seedList(db);

    const first = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(first.ok).toBe(true);
    if (first.ok) markRunning(db, first.runId);

    const second = createRun(db, { workflowId, listId: listB.listId, accountId });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.runId).not.toBe(first.runId);
  });

  it("still refuses to double-enroll the same target across two concurrent fire-and-forget runs", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const sharedTargetId = seedTarget(db);
    const listA = seedList(db, [sharedTargetId]);
    const listB = seedList(db, [sharedTargetId]);

    const first = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(first.ok).toBe(true);
    if (first.ok) markRunning(db, first.runId);

    const second = createRun(db, { workflowId, listId: listB.listId, accountId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("all_already_enrolled");

    // Only one run_profile for the shared target across all runs.
    const count = db
      .prepare("SELECT COUNT(*) as c FROM run_profiles WHERE target_id = ?")
      .get(sharedTargetId) as { c: number };
    expect(count.c).toBe(1);
  });

  it("keeps the one-active-run guard for a Connect -> Message workflow", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }, { step_type: "message" }]);
    const listA = seedList(db);
    const listB = seedList(db);

    const first = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(first.ok).toBe(true);
    if (first.ok) markRunning(db, first.runId);

    const second = createRun(db, { workflowId, listId: listB.listId, accountId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("workflow_already_active");
  });

  it("keeps the one-active-run guard for an email-only workflow", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "email", track: "email" }]);
    const listA = seedList(db);
    const listB = seedList(db);

    const first = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(first.ok).toBe(true);
    if (first.ok) markRunning(db, first.runId);

    const second = createRun(db, { workflowId, listId: listB.listId, accountId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("workflow_already_active");
  });
});

function trackStates(db: DB, runId: string): { state: string; next_step_at: string | null }[] {
  return db.prepare(
    `SELECT rt.state, rt.next_step_at FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     WHERE rp.run_id = ?`
  ).all(runId) as { state: string; next_step_at: string | null }[];
}

describe("createRun — no global list pollution (Problem 2)", () => {
  it("a fire-and-forget run created from list A contains only list A's targets", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const listA = seedList(db, [seedTarget(db), seedTarget(db)]);
    seedList(db, [seedTarget(db), seedTarget(db)]); // unrelated list B, never referenced

    const created = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const enrolledTargetIds = (db.prepare("SELECT target_id FROM run_profiles WHERE run_id = ?").all(created.runId) as { target_id: string }[])
      .map((r) => r.target_id)
      .sort();
    expect(enrolledTargetIds).toEqual([...listA.targetIds].sort());
  });

  it("targets that exist only in an unrelated list are never enrolled anywhere", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const listA = seedList(db, [seedTarget(db)]);
    const listB = seedList(db, [seedTarget(db), seedTarget(db)]);

    const created = createRun(db, { workflowId, listId: listA.listId, accountId });
    expect(created.ok).toBe(true);

    for (const targetId of listB.targetIds) {
      const enrolled = db.prepare("SELECT COUNT(*) as c FROM run_profiles WHERE target_id = ?").get(targetId) as { c: number };
      expect(enrolled.c).toBe(0);
    }
  });
});

describe("activateFireAndForgetRunImmediately (Problem 3: immediate activation, no scheduling spread)", () => {
  it("flips a fire-and-forget run's own pending LinkedIn tracks to in_progress with next_step_at cleared", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const list = seedList(db, [seedTarget(db), seedTarget(db)]);
    const created = createRun(db, { workflowId, listId: list.listId, accountId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(trackStates(db, created.runId).every((t) => t.state === "pending")).toBe(true);

    activateFireAndForgetRunImmediately(db, created.runId, workflowId);

    const after = trackStates(db, created.runId);
    expect(after).toHaveLength(2);
    expect(after.every((t) => t.state === "in_progress" && t.next_step_at === null)).toBe(true);
  });

  it("is a no-op for a non-fire-and-forget workflow — existing pending/spread pacing is preserved", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }, { step_type: "message" }]);
    const list = seedList(db, [seedTarget(db)]);
    const created = createRun(db, { workflowId, listId: list.listId, accountId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    activateFireAndForgetRunImmediately(db, created.runId, workflowId);

    expect(trackStates(db, created.runId).every((t) => t.state === "pending")).toBe(true);
  });

  it("does not touch another run's tracks", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowA = seedWorkflow(db, [{ step_type: "connect" }]);
    const workflowB = seedWorkflow(db, [{ step_type: "connect" }]);
    const listA = seedList(db, [seedTarget(db)]);
    const listB = seedList(db, [seedTarget(db)]);
    const runA = createRun(db, { workflowId: workflowA, listId: listA.listId, accountId });
    const runB = createRun(db, { workflowId: workflowB, listId: listB.listId, accountId });
    expect(runA.ok && runB.ok).toBe(true);
    if (!runA.ok || !runB.ok) return;

    activateFireAndForgetRunImmediately(db, runA.runId, workflowA);

    expect(trackStates(db, runB.runId).every((t) => t.state === "pending")).toBe(true);
  });

  it("startRun() activates a fire-and-forget run's tracks as part of starting it", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const list = seedList(db, [seedTarget(db)]);
    const created = createRun(db, { workflowId, listId: list.listId, accountId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const started = startRun(db, created.runId);
    expect(started.ok).toBe(true);

    expect(trackStates(db, created.runId).every((t) => t.state === "in_progress" && t.next_step_at === null)).toBe(true);
  });
});

describe("startRun — does not mutate account safety settings (Problem 2)", () => {
  it("starting a fire-and-forget referral run leaves daily limits and schedule untouched", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const before = db.prepare(
      `SELECT daily_connection_limit, daily_message_limit, daily_inmail_limit,
              active_hours_start, active_hours_end, working_days
       FROM accounts WHERE id = ?`
    ).get(accountId);

    const workflowId = seedWorkflow(db, [{ step_type: "connect" }]);
    const list = seedList(db, [seedTarget(db)]);
    const created = createRun(db, { workflowId, listId: list.listId, accountId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    startRun(db, created.runId);

    const after = db.prepare(
      `SELECT daily_connection_limit, daily_message_limit, daily_inmail_limit,
              active_hours_start, active_hours_end, working_days
       FROM accounts WHERE id = ?`
    ).get(accountId);
    expect(after).toEqual(before);
  });
});
