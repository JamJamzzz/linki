#!/usr/bin/env -S node --import tsx
// Runs exactly one deterministic Dropbox intake pass and exits. Same code path as the
// runner's background tick and POST /api/dropbox/intake — safe to run anytime for testing
// or operational recovery (e.g. after fixing a bad campaign.json, or a Dropbox outage).
//
// Usage:
//   npm run dropbox:intake
//
// Prints a JSON summary and exits 0. Exits 1 only if the pass itself couldn't run at all
// (e.g. DB open failure) — per-batch failures are reported in the summary, not as a
// nonzero exit, since one invalid batch must not look like a script failure.

import { getDb } from "@/lib/db";
import { runDropboxIntakeOnce } from "@/lib/dropbox/intake";
import { getDropboxIntakeConfig } from "@/lib/dropbox/config";

async function main() {
  const config = getDropboxIntakeConfig();
  if (!config) {
    console.log(JSON.stringify({ enabled: false, message: "Dropbox intake is disabled or not fully configured — see .env.example" }, null, 2));
    return;
  }

  const db = getDb();
  const summary = await runDropboxIntakeOnce(db, config);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => {
    // Force a clean exit — better-sqlite3/fetch can leave handles that keep the event
    // loop alive after a successful pass, which otherwise hangs the process indefinitely
    // instead of returning control to the caller (e.g. `docker compose exec`).
    process.exit(0);
  })
  .catch((err) => {
    console.error("[dropbox-intake] fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
