#!/usr/bin/env -S node --import tsx
// One-off, manual repair tool. Forces the NEXT accepted-connection sync (see
// lib/linkedin/sync-accepted.ts) to perform a full authoritative pass instead of an
// incremental one, by clearing the stored sync boundary/timestamp for authenticated
// LinkedIn accounts. Use this once after a matching-logic fix (like the /in/ vanity
// normalization fix) to repair historically-missed accepted connections that an
// incremental pass would otherwise never revisit.
//
// Touches ONLY accounts.connections_synced_through_ms and accounts.accepted_sync_at.
// Does NOT touch degree, connected_at, connection_requested_at, credentials, session
// state, or any run/campaign row — the normal accepted-sync/export path (authoritative
// Voyager connections API, checksum-verified full pass, phantom correction) does the
// actual repair on its own next run; this script only makes that account "due".
//
// Usage:
//   npm run accepted-sync:force-full
//
// This is manual and one-shot by design — never run automatically on deploy/startup.

import { getDb } from "@/lib/db";

function main() {
  const db = getDb();

  const accounts = db.prepare(
    "SELECT id, name, connections_synced_through_ms, accepted_sync_at FROM accounts WHERE is_authenticated = 1"
  ).all() as Array<{ id: string; name: string; connections_synced_through_ms: number | null; accepted_sync_at: string | null }>;

  if (accounts.length === 0) {
    console.log(JSON.stringify({ reset: 0, message: "No authenticated LinkedIn accounts found — nothing to reset." }, null, 2));
    return;
  }

  const reset = db.prepare(
    "UPDATE accounts SET connections_synced_through_ms = NULL, accepted_sync_at = NULL WHERE id = ?"
  );
  const tx = db.transaction((rows: typeof accounts) => {
    for (const a of rows) reset.run(a.id);
  });
  tx(accounts);

  console.log(JSON.stringify(
    {
      reset: accounts.length,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        was_boundary_ms: a.connections_synced_through_ms,
        was_accepted_sync_at: a.accepted_sync_at,
      })),
      message: "Boundary cleared. The global runner's accepted-sync maintenance will treat these accounts as due and perform a full authoritative pass on its next tick (within a few seconds if the app is already running).",
    },
    null,
    2
  ));
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("[reset-accepted-sync-boundary] fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
