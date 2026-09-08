import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";

// Small, targeted mocks — only the Playwright-touching pieces the connect/visit steps
// call. Everything else in runner.ts (premium, apollo, email, message, sync-accepted...)
// loads for real, same as the existing Dropbox intake tests already do transitively.
vi.mock("@/lib/linkedin/session", () => ({
  getSessionPage: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  saveSessionState: vi.fn(async () => {}),
  getSessionContext: vi.fn(async () => ({})),
  markNeedsReauth: vi.fn(async () => {}),
}));

vi.mock("@/lib/linkedin/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/linkedin/connect")>();
  return { ...actual, sendConnectionRequest: vi.fn(async () => {}) };
});

vi.mock("@/lib/linkedin/visit", () => ({
  visitProfile: vi.fn(async () => ({ isFirstDegree: false, messagingUrn: null })),
}));

type DB = DatabaseType.Database;

type WorkflowStep = import("@/lib/linkedin/runner").WorkflowStep;

let createDatabase: typeof import("@/lib/db").createDatabase;
let executeStep: typeof import("@/lib/linkedin/runner").executeStep;
let hasFutureAcceptanceDependentMessage: typeof import("@/lib/linkedin/runner").hasFutureAcceptanceDependentMessage;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendConnectionRequestMock: any;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ executeStep, hasFutureAcceptanceDependentMessage } = await import("@/lib/linkedin/runner"));
  const connectModule = await import("@/lib/linkedin/connect");
  sendConnectionRequestMock = connectModule.sendConnectionRequest;
});

beforeEach(() => {
  sendConnectionRequestMock.mockClear();
  sendConnectionRequestMock.mockResolvedValue(undefined);
});

function freshDb(): DB {
  return createDatabase(":memory:");
}

const ACCOUNT_LIMITS = {
  daily_connection_limit: 999,
  daily_message_limit: 999,
  daily_inmail_limit: 999,
  active_hours_start: 0,
  active_hours_end: 24,
  timezone: "UTC",
  working_days: "1,2,3,4,5,6,7",
};

function seedAccount(db: DB): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit, active_hours_start, active_hours_end, timezone, working_days)
     VALUES (?, 'Test Account', ?, 1, 999, 999, 999, 0, 24, 'UTC', '1,2,3,4,5,6,7')`
  ).run(id, `${id}@example.com`);
  return id;
}

interface StepSpec { step_type: string; delay_seconds?: number }

/** Seeds a workflow whose LinkedIn track has exactly `steps`, in order. */
function seedLinkedinWorkflow(db: DB, steps: StepSpec[]): string {
  const workflowId = randomUUID();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, 'Test Workflow')").run(workflowId);
  steps.forEach((s, i) => {
    db.prepare(
      "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, delay_seconds) VALUES (?, ?, ?, ?, 'linkedin', ?)"
    ).run(randomUUID(), workflowId, i + 1, s.step_type, s.delay_seconds ?? 0);
  });
  return workflowId;
}

function getLinkedinSteps(db: DB, workflowId: string): WorkflowStep[] {
  return db.prepare(
    "SELECT * FROM workflow_steps WHERE workflow_id = ? AND track = 'linkedin' ORDER BY step_order"
  ).all(workflowId) as WorkflowStep[];
}

function seedTarget(db: DB): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, 'Test Person')"
  ).run(id, `https://www.linkedin.com/in/test-${id}/`);
  return id;
}

function seedRun(db: DB, workflowId: string, accountId: string): string {
  const runId = randomUUID();
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, ?, ?, 'running')").run(runId, workflowId, accountId);
  return runId;
}

/** Inserts run_profiles/run_profile_tracks rows and returns a TrackRun-shaped object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedTrackRun(db: DB, opts: { runId: string; targetId: string; accountId: string; workflowId: string; currentStep?: number }): any {
  const rpId = randomUUID();
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(rpId, opts.runId, opts.targetId);
  const trId = randomUUID();
  db.prepare(
    "INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, 'linkedin', 'in_progress', ?)"
  ).run(trId, rpId, opts.currentStep ?? 0);
  return {
    id: trId,
    run_profile_id: rpId,
    track: "linkedin",
    state: "in_progress",
    current_step: opts.currentStep ?? 0,
    next_step_at: null,
    error_message: null,
    last_email_subject: null,
    last_email_body: null,
    last_linkedin_message: null,
    pending_reply_context: null,
    run_id: opts.runId,
    target_id: opts.targetId,
    email_account_id: null,
    account_id: opts.accountId,
    workflow_id: opts.workflowId,
    connection_requested_at: null,
  };
}

function readTrack(db: DB, id: string) {
  return db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(id) as {
    state: string; current_step: number; next_step_at: string | null;
  };
}
function readTarget(db: DB, id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.prepare("SELECT * FROM targets WHERE id = ?").get(id) as any;
}

describe("hasFutureAcceptanceDependentMessage (pure helper)", () => {
  it("connect-only workflow: false", () => {
    expect(hasFutureAcceptanceDependentMessage([{ step_type: "connect" }], 0)).toBe(false);
  });
  it("visit -> connect: false", () => {
    expect(
      hasFutureAcceptanceDependentMessage([{ step_type: "visit" }, { step_type: "connect" }], 1)
    ).toBe(false);
  });
  it("connect -> delay -> message: true", () => {
    expect(
      hasFutureAcceptanceDependentMessage(
        [{ step_type: "connect" }, { step_type: "delay" }, { step_type: "message" }],
        0
      )
    ).toBe(true);
  });
  it("connect -> harmless delay-only tail: false", () => {
    expect(
      hasFutureAcceptanceDependentMessage([{ step_type: "connect" }, { step_type: "delay" }], 0)
    ).toBe(false);
  });
  it("connect -> sales_inmail: false (InMail doesn't need 1st-degree)", () => {
    expect(
      hasFutureAcceptanceDependentMessage([{ step_type: "connect" }, { step_type: "sales_inmail" }], 0)
    ).toBe(false);
  });
});

describe("connect step — fire-and-forget completion (executeStep integration)", () => {
  it("Connect-only: sends the invite, records connection_requested_at, and completes the track immediately (no 6h wait)", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedLinkedinWorkflow(db, [{ step_type: "connect" }]);
    const targetId = seedTarget(db);
    const runId = seedRun(db, workflowId, accountId);
    const tr = seedTrackRun(db, { runId, targetId, accountId, workflowId });
    const steps = getLinkedinSteps(db, workflowId);

    await executeStep(db, runId, tr, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);

    expect(sendConnectionRequestMock).toHaveBeenCalledTimes(1);
    expect(readTarget(db, targetId).connection_requested_at).not.toBeNull();

    const track = readTrack(db, tr.id);
    expect(track.state).toBe("completed");
    expect(track.current_step).toBe(1);
    expect(track.next_step_at).toBeNull(); // not scheduled hours into the future
  });

  it("Visit -> Connect: completes after the outbound connect (two sequential ticks)", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedLinkedinWorkflow(db, [{ step_type: "visit" }, { step_type: "connect" }]);
    const targetId = seedTarget(db);
    const runId = seedRun(db, workflowId, accountId);
    const tr = seedTrackRun(db, { runId, targetId, accountId, workflowId, currentStep: 0 });
    const steps = getLinkedinSteps(db, workflowId);

    await executeStep(db, runId, tr, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);
    let track = readTrack(db, tr.id);
    expect(track.state).toBe("in_progress");
    expect(track.current_step).toBe(1);
    expect(sendConnectionRequestMock).not.toHaveBeenCalled();

    await executeStep(db, runId, { ...tr, current_step: 1 }, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);
    track = readTrack(db, tr.id);
    expect(track.state).toBe("completed");
    expect(sendConnectionRequestMock).toHaveBeenCalledTimes(1);
  });

  it("Connect -> Email (separate track): the connect step still completes immediately", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedLinkedinWorkflow(db, [{ step_type: "connect" }]);
    // A separate email-track step on the SAME workflow must not make the helper think a
    // future acceptance-dependent message exists — getSteps() already scopes by track.
    db.prepare(
      "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, email_subject, email_body) VALUES (?, ?, 1, 'email', 'email', 'Hi', 'Body')"
    ).run(randomUUID(), workflowId);
    const targetId = seedTarget(db);
    const runId = seedRun(db, workflowId, accountId);
    const tr = seedTrackRun(db, { runId, targetId, accountId, workflowId });
    const steps = getLinkedinSteps(db, workflowId);

    await executeStep(db, runId, tr, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);

    const track = readTrack(db, tr.id);
    expect(track.state).toBe("completed");
    expect(sendConnectionRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe("connect step — Connect -> Message still waits for acceptance", () => {
  it("does not advance past connect and reschedules ~6h out after sending", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedLinkedinWorkflow(db, [
      { step_type: "connect" },
      { step_type: "delay" },
      { step_type: "message" },
    ]);
    const targetId = seedTarget(db);
    const runId = seedRun(db, workflowId, accountId);
    const tr = seedTrackRun(db, { runId, targetId, accountId, workflowId });
    const steps = getLinkedinSteps(db, workflowId);

    await executeStep(db, runId, tr, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);

    expect(sendConnectionRequestMock).toHaveBeenCalledTimes(1);
    expect(readTarget(db, targetId).connection_requested_at).not.toBeNull();

    const track = readTrack(db, tr.id);
    expect(track.state).toBe("in_progress");
    expect(track.current_step).toBe(0); // NOT advanced past connect
    expect(track.next_step_at).not.toBeNull();
    const hoursUntil = (new Date(track.next_step_at!).getTime() - Date.now()) / 3_600_000;
    expect(hoursUntil).toBeGreaterThan(5);
    expect(hoursUntil).toBeLessThan(7);
  });

  it("a later poll before acceptance keeps waiting instead of completing", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const workflowId = seedLinkedinWorkflow(db, [{ step_type: "connect" }, { step_type: "message" }]);
    const targetId = seedTarget(db);
    const runId = seedRun(db, workflowId, accountId);
    const tr = seedTrackRun(db, { runId, targetId, accountId, workflowId });
    const steps = getLinkedinSteps(db, workflowId);

    // First send.
    await executeStep(db, runId, tr, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);
    // Second poll — invite already sent, target still not accepted (degree stays null).
    await executeStep(db, runId, { ...tr, next_step_at: null }, readTarget(db, targetId), steps, accountId, ACCOUNT_LIMITS);

    expect(sendConnectionRequestMock).toHaveBeenCalledTimes(1); // never sent twice
    const track = readTrack(db, tr.id);
    expect(track.state).toBe("in_progress");
    expect(track.current_step).toBe(0);
  });
});
