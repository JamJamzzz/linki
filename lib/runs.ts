import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";

type DB = DatabaseType.Database;

export interface CreateRunParams {
  workflowId: string;
  listId: string;
  accountId: string;
  emailAccountId?: string | null;
  emailAccountIds?: string[];
  targetIds?: string[];
}

export type CreateRunResult =
  | { ok: true; runId: string }
  | { ok: false; error: "workflow_already_active"; message: string }
  | { ok: false; error: "all_already_enrolled"; message: string };

/**
 * Create a run (enroll a list/targets into a workflow) exactly as
 * POST /api/runs does. Extracted so both the HTTP route and non-HTTP callers
 * (e.g. Dropbox intake) share one implementation — behavior is unchanged from
 * the original inline handler.
 */
export function createRun(db: DB, params: CreateRunParams): CreateRunResult {
  const { workflowId, listId, accountId } = params;

  const emailAccountPool: string[] =
    Array.isArray(params.emailAccountIds) && params.emailAccountIds.length > 0
      ? params.emailAccountIds
      : params.emailAccountId
        ? [params.emailAccountId]
        : [];

  const activeRun = db.prepare(
    "SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused') LIMIT 1"
  ).get(workflowId) as { id: string } | undefined;
  if (activeRun) {
    return {
      ok: false,
      error: "workflow_already_active",
      message: "This workflow is already running. Stop or pause it before enrolling a new list.",
    };
  }

  const runId = randomUUID();
  db
    .prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, email_account_id) VALUES (?, ?, ?, ?, ?)")
    .run(runId, workflowId, listId, accountId, emailAccountPool[0] ?? null);

  const candidates: { target_id: string }[] = Array.isArray(params.targetIds) && params.targetIds.length > 0
    ? params.targetIds.map((id) => ({ target_id: id }))
    : db.prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(listId) as { target_id: string }[];

  const alreadyEnrolled = new Set(
    (db.prepare(
      `SELECT DISTINCT rp.target_id FROM run_profiles rp
       JOIN runs r ON r.id = rp.run_id
       WHERE r.workflow_id = ?`
    ).all(workflowId) as { target_id: string }[]).map((r) => r.target_id)
  );

  const activeElsewhere = new Set(
    (db.prepare(
      `SELECT DISTINCT rp.target_id FROM run_profiles rp
       JOIN runs r ON r.id = rp.run_id
       WHERE r.status IN ('running', 'paused')
       AND EXISTS (
         SELECT 1 FROM run_profile_tracks rt
         WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped')
       )`
    ).all() as { target_id: string }[]).map((r) => r.target_id)
  );

  const targets = candidates.filter((t) => !alreadyEnrolled.has(t.target_id) && !activeElsewhere.has(t.target_id));

  if (targets.length === 0) {
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    return {
      ok: false,
      error: "all_already_enrolled",
      message: "All selected contacts are already enrolled in this workflow.",
    };
  }

  const emailAssignment: Map<string, string | null> = new Map();
  if (emailAccountPool.length > 0) {
    const targetIds = targets.map((t) => t.target_id);
    const placeholders = targetIds.map(() => "?").join(",");
    const companyRows = db.prepare(
      `SELECT id, company_id FROM targets WHERE id IN (${placeholders})`
    ).all(...targetIds) as { id: string; company_id: string | null }[];

    const companyAccountMap = new Map<string, string>();
    let poolCursor = 0;

    for (const row of companyRows) {
      if (row.company_id) {
        if (!companyAccountMap.has(row.company_id)) {
          companyAccountMap.set(row.company_id, emailAccountPool[poolCursor % emailAccountPool.length]);
          poolCursor++;
        }
        emailAssignment.set(row.id, companyAccountMap.get(row.company_id)!);
      } else {
        emailAssignment.set(row.id, emailAccountPool[poolCursor % emailAccountPool.length]);
        poolCursor++;
      }
    }
  }

  const workflowTracks = [...new Set(
    (db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as { track: string }[]).map((r) => r.track)
  )];
  if (workflowTracks.length === 0) workflowTracks.push("linkedin");

  const insertProfile = db.prepare(
    "INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)"
  );
  const insertTrack = db.prepare(
    "INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?, ?, ?, 'pending', 0)"
  );
  const insertMany = db.transaction((ts: { target_id: string }[]) => {
    for (const t of ts) {
      const assignedEmailAccountId = emailAssignment.get(t.target_id) ?? null;
      const rpId = randomUUID();
      insertProfile.run(rpId, runId, t.target_id, assignedEmailAccountId);
      for (const track of workflowTracks) {
        if (track === "email" && !assignedEmailAccountId) continue;
        insertTrack.run(randomUUID(), rpId, track);
      }
    }
  });
  insertMany(targets);

  return { ok: true, runId };
}

/**
 * Start a pending run, exactly as POST /api/runs/[id]/start does.
 */
export function startRun(db: DB, runId: string): { ok: true } | { ok: false; error: string } {
  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (!run) return { ok: false, error: "Run not found" };
  if (run.status === "running") return { ok: false, error: "Run already running" };

  db.prepare(
    "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?"
  ).run(runId);

  ensureGlobalRunnerStarted();

  return { ok: true };
}
