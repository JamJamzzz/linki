import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

const g = global as typeof global & { __linkiPersonalAutoStarted?: boolean };

interface RunningRun {
  id: string;
  workflow_id: string;
  account_id: string;
  email_account_id: string | null;
}

/**
 * Personal single-user mode:
 * - every running campaign automatically consumes every contact present in any list;
 * - contacts already enrolled in the same workflow are skipped;
 * - contacts actively running in another workflow are skipped to avoid duplicate sends;
 * - new tracks start immediately (no pending batch / spread window);
 * - the LinkedIn account is kept 24/7 with effectively-disabled daily caps.
 *
 * This is intentionally aggressive and is meant for this personal fork, not a multi-tenant deployment.
 */
function autoEnrollRun(run: RunningRun): number {
  const db = getDb();

  // Remove Linki's local pacing gates for the account used by this run.
  // LinkedIn-side hard limits/errors are still handled by the normal runner.
  db.prepare(`
    UPDATE accounts
    SET daily_connection_limit = 10000,
        daily_message_limit = 10000,
        daily_inmail_limit = 10000,
        active_hours_start = 0,
        active_hours_end = 24,
        working_days = '1,2,3,4,5,6,7'
    WHERE id = ?
  `).run(run.account_id);

  const workflowTracks = [...new Set(
    (db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?")
      .all(run.workflow_id) as Array<{ track: string }>).map((r) => r.track)
  )];
  if (workflowTracks.length === 0) workflowTracks.push("linkedin");

  // Reuse an email account already attached to the run when an email track exists.
  const existingEmail = db.prepare(`
    SELECT email_account_id
    FROM run_profiles
    WHERE run_id = ? AND email_account_id IS NOT NULL
    LIMIT 1
  `).get(run.id) as { email_account_id: string } | undefined;
  const emailAccountId = existingEmail?.email_account_id ?? run.email_account_id ?? null;

  const candidates = db.prepare(`
    SELECT DISTINCT lt.target_id
    FROM list_targets lt
    WHERE NOT EXISTS (
      SELECT 1
      FROM run_profiles rp
      JOIN runs r ON r.id = rp.run_id
      WHERE r.workflow_id = ?
        AND rp.target_id = lt.target_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM run_profiles rp2
      JOIN runs r2 ON r2.id = rp2.run_id
      WHERE rp2.target_id = lt.target_id
        AND r2.id <> ?
        AND r2.status IN ('running', 'paused')
        AND EXISTS (
          SELECT 1
          FROM run_profile_tracks rt2
          WHERE rt2.run_profile_id = rp2.id
            AND rt2.state NOT IN ('completed', 'failed', 'skipped')
        )
    )
    ORDER BY lt.target_id
  `).all(run.workflow_id, run.id) as Array<{ target_id: string }>;

  if (candidates.length === 0) return 0;

  const insertProfile = db.prepare(
    "INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)"
  );
  const insertTrack = db.prepare(`
    INSERT INTO run_profile_tracks
      (id, run_profile_id, track, state, current_step, next_step_at)
    VALUES (?, ?, ?, 'in_progress', 0, datetime('now'))
  `);

  const insertMany = db.transaction((rows: Array<{ target_id: string }>) => {
    for (const row of rows) {
      const rpId = randomUUID();
      insertProfile.run(rpId, run.id, row.target_id, emailAccountId);

      for (const track of workflowTracks) {
        if (track === "email" && !emailAccountId) continue;
        insertTrack.run(randomUUID(), rpId, track);
      }
    }
  });

  insertMany(candidates);

  db.prepare(
    "INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, NULL, 'info', ?)"
  ).run(
    randomUUID(),
    run.id,
    `Personal auto mode enrolled ${candidates.length} contact${candidates.length === 1 ? "" : "s"} from all lists for immediate processing`
  );

  return candidates.length;
}

function autoEnrollAllRunningRuns(): number {
  const db = getDb();
  const runs = db.prepare(`
    SELECT id, workflow_id, account_id, email_account_id
    FROM runs
    WHERE status = 'running'
    ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC
  `).all() as RunningRun[];

  let total = 0;
  for (const run of runs) total += autoEnrollRun(run);
  return total;
}

export function startPersonalAutoEnroller(): void {
  if (g.__linkiPersonalAutoStarted) return;
  g.__linkiPersonalAutoStarted = true;

  const tick = () => {
    try {
      const enrolled = autoEnrollAllRunningRuns();
      if (enrolled > 0) {
        console.log(`[personal-auto] Enrolled ${enrolled} contact${enrolled === 1 ? "" : "s"} for immediate processing`);
      }
    } catch (err) {
      console.error("[personal-auto] Tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Run immediately on boot, then keep absorbing any contacts added later.
  tick();
  setInterval(tick, 5000);
}
