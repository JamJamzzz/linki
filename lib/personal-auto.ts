import type DatabaseType from "better-sqlite3";
import { randomUUID } from "crypto";

type DB = DatabaseType.Database;

// Personal aggressive-mode auto-enroller for a single-user Linki fork.
//
// While a campaign (workflow run) is RUNNING, every contact sitting in ANY list is
// automatically pulled into that run and made immediately executable — no manual
// "Add contacts" click, no waiting for Linki's normal pending -> spread-across-the-day
// enrollment (see spreadEnrollBatch in lib/linkedin/runner.ts, which batches 5 at a time
// and scatters next_step_at randomly across the account's active-hours window). New
// tracks here are inserted directly as state='in_progress' with next_step_at = NULL,
// which the runner's due-track query treats as "due right now" — that deliberately
// bypasses spreadEnrollBatch entirely, since that function only ever looks at
// state='pending' rows.
//
// This also strips Linki's own local conservative pacing (daily caps, active-hours
// window, working-days) off the LinkedIn account attached to each running run, by
// raising those columns on the `accounts` row itself — the same row lib/linkedin/runner.ts
// already reads for every gate (isWithinSchedule, daily_connection_limit, etc). Real
// LinkedIn-side failures (auth, weekly/hard limits, page errors) are untouched: those are
// thrown by lib/linkedin/connect.ts etc. and handled independently in executeStep.
//
// Runs once per runner tick (see globalLoop in lib/linkedin/runner.ts).

const MAX_DAILY_LIMIT = 999999;
const ALL_WEEK = "1,2,3,4,5,6,7";

interface ActiveRun {
  run_id: string;
  workflow_id: string;
  account_id: string;
}

function unthrottleAccount(db: DB, accountId: string): void {
  const account = db.prepare(
    `SELECT daily_connection_limit, daily_message_limit, daily_inmail_limit,
            active_hours_start, active_hours_end, working_days
     FROM accounts WHERE id = ?`
  ).get(accountId) as {
    daily_connection_limit: number | null;
    daily_message_limit: number | null;
    daily_inmail_limit: number | null;
    active_hours_start: number | null;
    active_hours_end: number | null;
    working_days: string | null;
  } | undefined;
  if (!account) return;

  const alreadyUnthrottled =
    (account.daily_connection_limit ?? 0) >= MAX_DAILY_LIMIT &&
    (account.daily_message_limit ?? 0) >= MAX_DAILY_LIMIT &&
    (account.daily_inmail_limit ?? 0) >= MAX_DAILY_LIMIT &&
    account.active_hours_start === 0 &&
    account.active_hours_end === 24 &&
    account.working_days === ALL_WEEK;
  if (alreadyUnthrottled) return;

  db.prepare(`
    UPDATE accounts SET
      daily_connection_limit = ?,
      daily_message_limit = ?,
      daily_inmail_limit = ?,
      active_hours_start = 0,
      active_hours_end = 24,
      working_days = ?
    WHERE id = ?
  `).run(MAX_DAILY_LIMIT, MAX_DAILY_LIMIT, MAX_DAILY_LIMIT, ALL_WEEK, accountId);
  console.log(`[personal-auto] Removed local pacing limits for account ${accountId} (personal aggressive mode)`);
}

/** Every distinct target sitting in any list, right now. */
function allListedTargetIds(db: DB): string[] {
  return (db.prepare("SELECT DISTINCT target_id FROM list_targets").all() as { target_id: string }[])
    .map((r) => r.target_id);
}

/**
 * Enrolls every not-yet-claimed listed contact into `run`, transactionally, as
 * immediately-runnable track-runs. Mirrors the dedup + email-round-robin logic in
 * pages/api/runs/[id]/enroll.ts and lib/runs.ts's createRun exactly, so behavior stays
 * consistent with manual enrollment — the only deliberate difference is the initial
 * track state (in_progress + due now, instead of pending).
 */
function enrollIntoRun(db: DB, run: ActiveRun): number {
  const candidates = allListedTargetIds(db);
  if (candidates.length === 0) return 0;

  // Never re-enroll a target already in this workflow (any run, any state — matches
  // the existing create-run/manual-enroll rule). Never double-send to a target that's
  // actively in progress in some other running/paused run.
  const alreadyEnrolled = new Set(
    (db.prepare(
      `SELECT DISTINCT rp.target_id FROM run_profiles rp
       JOIN runs r ON r.id = rp.run_id
       WHERE r.workflow_id = ?`
    ).all(run.workflow_id) as { target_id: string }[]).map((r) => r.target_id)
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

  const eligible = candidates.filter((id) => !alreadyEnrolled.has(id) && !activeElsewhere.has(id));
  if (eligible.length === 0) return 0;

  // Which tracks this workflow actually has steps for — a LinkedIn-only campaign needs
  // no email account at all.
  const workflowTracks = [...new Set(
    (db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(run.workflow_id) as { track: string }[])
      .map((r) => r.track)
  )];
  if (workflowTracks.length === 0) workflowTracks.push("linkedin");

  // Reuse whatever email account(s) this run already has assigned — company-grouped
  // round-robin, same strategy as run creation/manual enroll — only relevant if the
  // workflow has an email track.
  const emailAccountPool: string[] = workflowTracks.includes("email")
    ? (db.prepare(
        `SELECT DISTINCT email_account_id FROM run_profiles WHERE run_id = ? AND email_account_id IS NOT NULL`
      ).all(run.run_id) as { email_account_id: string }[]).map((r) => r.email_account_id)
    : [];

  const emailAssignment = new Map<string, string | null>();
  if (emailAccountPool.length > 0) {
    const placeholders = eligible.map(() => "?").join(",");
    const companyRows = db.prepare(`SELECT id, company_id FROM targets WHERE id IN (${placeholders})`)
      .all(...eligible) as { id: string; company_id: string | null }[];
    const companyAccountMap = new Map<string, string>();
    let cursor = 0;
    for (const row of companyRows) {
      if (row.company_id) {
        if (!companyAccountMap.has(row.company_id)) {
          companyAccountMap.set(row.company_id, emailAccountPool[cursor % emailAccountPool.length]);
          cursor++;
        }
        emailAssignment.set(row.id, companyAccountMap.get(row.company_id)!);
      } else {
        emailAssignment.set(row.id, emailAccountPool[cursor % emailAccountPool.length]);
        cursor++;
      }
    }
  }

  const insertProfile = db.prepare(
    "INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)"
  );
  // state='in_progress' + next_step_at=NULL = due right now to the runner's due-track
  // query, deliberately skipping spreadEnrollBatch's 5-at-a-time / randomly-spread-across-the-day enrollment.
  const insertTrack = db.prepare(
    "INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at) VALUES (?, ?, ?, 'in_progress', 0, NULL)"
  );
  const insertMany = db.transaction((ids: string[]) => {
    for (const targetId of ids) {
      const assignedEmailAccountId = emailAssignment.get(targetId) ?? null;
      const rpId = randomUUID();
      insertProfile.run(rpId, run.run_id, targetId, assignedEmailAccountId);
      for (const track of workflowTracks) {
        // Skip the email track if no email account is configured on this run.
        if (track === "email" && !assignedEmailAccountId) continue;
        insertTrack.run(randomUUID(), rpId, track);
      }
    }
  });
  insertMany(eligible);

  return eligible.length;
}

/**
 * Runs once per runner tick. For every currently-running campaign (oldest first, so if
 * more than one happens to be active a target is only ever claimed by one of them),
 * pulls in every contact from every list that isn't already spoken for and makes it
 * immediately runnable, and removes Linki's local pacing from that run's LinkedIn account.
 */
export async function runPersonalAutoEnroll(db: DB): Promise<void> {
  const activeRuns = db.prepare(
    `SELECT id as run_id, workflow_id, account_id FROM runs WHERE status = 'running' ORDER BY created_at ASC`
  ).all() as ActiveRun[];

  for (const run of activeRuns) {
    unthrottleAccount(db, run.account_id);
    const enrolled = enrollIntoRun(db, run);
    if (enrolled > 0) {
      console.log(
        `[personal-auto] Enrolled ${enrolled} contact(s) from lists into run ${run.run_id} (workflow ${run.workflow_id}) — ready immediately`
      );
    }
  }
}
