import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

let createDatabase: typeof import("@/lib/db").createDatabase;
let createRun: typeof import("@/lib/runs").createRun;
let isFireAndForgetWorkflow: typeof import("@/lib/runs").isFireAndForgetWorkflow;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ createRun, isFireAndForgetWorkflow } = await import("@/lib/runs"));
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
