# Dropbox intake

Linki can watch a dedicated Dropbox folder for contact-import batches. Every ready direct
child folder under the configured root becomes a Linki list (via the existing CSV import
path), optionally enrolled into an existing workflow and launched.

This is **only** the Dropbox → Linki execution bridge: it validates a manifest + CSV,
imports contacts through Linki's existing import logic, creates/reuses a list, optionally
launches an existing workflow, and archives the folder. It does not discover jobs, scrape
LinkedIn/Apollo, or generate messages — those are upstream producers that write valid
folders into Dropbox for Linki to pick up.

Disabled by default. With `DROPBOX_INTAKE_ENABLED` unset or `false` (or credentials
incomplete), Linki runs exactly as it does today — no polling, no new behavior.

## 1. Create a Dropbox app

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Scoped access**, and **App folder** access type (not "Full Dropbox"). App-folder
   access confines the app to its own sandboxed folder inside the user's Dropbox — this is
   what guarantees Linki never sees or touches the rest of the user's Dropbox, independent
   of the `DROPBOX_INTAKE_ROOT` setting.
3. Under **Permissions**, enable these scopes and re-generate the access token afterward:
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write` (needed to archive processed/failed folders and write `result.json`)
4. Under **Settings**, note the **App key** and **App secret** — these become
   `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET`.

## 2. Obtain a refresh token

Linki uses a long-lived OAuth **refresh token**, not a short-lived access token, so it
doesn't need re-authorization every few hours. Run the standard Dropbox OAuth2 code flow
once, with `token_access_type=offline` to receive a refresh token:

1. Open in a browser (replace `APP_KEY`):
   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
   ```
2. Approve access, copy the resulting authorization `code`.
3. Exchange it for tokens:
   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=AUTH_CODE \
     -d grant_type=authorization_code \
     -d client_id=APP_KEY \
     -d client_secret=APP_SECRET
   ```
4. The response's `refresh_token` is what goes into `DROPBOX_REFRESH_TOKEN`. Linki exchanges
   it for fresh access tokens automatically as needed (see `lib/dropbox/client.ts`) — nothing
   else to renew.

## 3. Environment variables

Set these in `.env.local` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DROPBOX_INTAKE_ENABLED` | `false` | Master on/off switch. Everything else is ignored when this isn't exactly `"true"`. |
| `DROPBOX_APP_KEY` | — | Dropbox app key. |
| `DROPBOX_APP_SECRET` | — | Dropbox app secret. |
| `DROPBOX_REFRESH_TOKEN` | — | Long-lived refresh token from step 2. |
| `DROPBOX_INTAKE_ROOT` | `/LinkiInbox` | Root folder to monitor. Only its **direct child folders** are scanned — nested folders, and anything outside this root, are never touched. |
| `DROPBOX_INTAKE_POLL_INTERVAL_SECONDS` | `60` | Minimum gap between intake passes in the background runner. |
| `DROPBOX_INTAKE_MAX_ROWS` | `500` | `contacts.csv` row-count limit — larger files are rejected with an actionable error instead of being silently truncated. |

Never commit real values for these — `.env.local` is git-ignored, same as every other Linki
secret. Linki never logs credentials, tokens, or the `Authorization` header.

## 4. Folder & file contract

```
/LinkiInbox/                          ← DROPBOX_INTAKE_ROOT
  ixl-swe-ng-31102/                   ← one direct child folder = one batch
    campaign.json
    contacts.csv
    _READY                            ← empty marker file, upload LAST
```

- Only **direct children** of the root are batches. Nested subfolders inside a batch folder
  are ignored (not recursed into). Hidden/system files (dotfiles) and temp files
  (`*.tmp`, `~$*`, `*~`) are ignored everywhere they appear.
- A folder is only processed once `_READY` exists inside it. **Upload `_READY` last** — write
  `campaign.json` and `contacts.csv` first, then `_READY`, so Linki never picks up a
  partially-uploaded batch. If a folder has `campaign.json`/`contacts.csv` but no `_READY`
  yet, Linki simply skips it (not an error) and checks again next pass.
- Once `_READY` is present, both `campaign.json` and `contacts.csv` are required — a folder
  missing either is a terminal (non-retryable) validation error.

### `campaign.json`

```json
{
  "schema_version": 1,
  "batch_id": "ixl-swe-ng-31102",
  "list_name": "IXL SWE New Grad",
  "workflow_id": "existing-linki-workflow-id",
  "linkedin_account_id": "optional-existing-account-id",
  "email_account_id": "optional-existing-account-id",
  "auto_launch": true
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Must be `1`. Any other value is rejected with a clear "unsupported schema version" error. |
| `batch_id` | yes | Letters, numbers, `.`, `_`, `-` only. Globally unique across all batches ever seen — see [Idempotency](#idempotency--concurrency). |
| `list_name` | yes | The Linki list to create, or reuse if a list with this exact name already exists. |
| `workflow_id` | required when `auto_launch: true` | Must reference an existing, non-archived workflow. Never guessed. |
| `linkedin_account_id` | required when `auto_launch: true` | Must reference an existing, authenticated LinkedIn account. Linki's run API requires a LinkedIn account on every run, even email-only workflows — see `pages/api/runs/index.ts`. |
| `email_account_id` | optional | Must reference an existing email account if provided. |
| `auto_launch` | optional, default `false` | When `true`, creates and starts a run for the imported list against `workflow_id` exactly once. |

Any other keys (e.g. `job_id`, `job_url`, `priority`, `source` from an upstream producer)
are simply ignored — they don't break validation and aren't persisted. `campaign.json` is
intentionally the only source of workflow/account selection; Linki never falls back to an
arbitrary workflow or account.

### `contacts.csv`

Same format Linki's own CSV import already uses (`lib/csv-import.ts`, also downloadable
from the app via **Lists → Import → Download template**, or `GET
/api/lists/:id/csv-template`). Columns: `linkedin_url`, `sales_nav_url`, `email`,
`first_name`, `last_name`, `title`, `company`, `location`, `city`, `country`, `phone`,
`headline`, `summary`, `notes`. Each row needs at least a `linkedin_url` or an `email` —
rows with neither are skipped (not a batch-level failure) and counted in the processing
result. Contacts are deduped exactly the way manual CSV imports are (by `linkedin_url`,
falling back to `email`) — no separate dedup logic was written for this feature.

## 5. What happens to a batch

1. **Discover** — the background runner (or a manual pass) lists the root's direct child
   folders and looks for `_READY`.
2. **Validate** — `campaign.json` and `contacts.csv` are downloaded and validated (schema,
   referenced workflow/accounts exist, row count within `DROPBOX_INTAKE_MAX_ROWS`).
3. **Claim** — the batch is recorded in Linki's database (`dropbox_intake_batches`) with a
   uniqueness constraint that makes claiming atomic — see [Idempotency](#idempotency--concurrency).
4. **Import** — contacts are imported via Linki's existing `importCsv()` into a
   created-or-reused list.
5. **Launch** (only if `auto_launch: true`) — a run is created and started against
   `workflow_id`, using the same code path as the **Runs** UI (extracted into `lib/runs.ts`).
6. **Archive** — the Dropbox folder is moved to:
   - `/LinkiProcessed/<original-folder-name>` on success
   - `/LinkiFailed/<original-folder-name>` on a terminal (non-retryable) failure
   A `result.json` is written into the archived folder with the batch id, final status,
   list/run ids, and contact counts (never full contact rows).

A **transient** failure (Dropbox rate limiting, a network blip) leaves the folder in place
and marks the batch retryable — it's picked up again on the next pass, up to 10 attempts
before being demoted to a terminal failure and archived to `/LinkiFailed`. One bad batch
never blocks any other batch in the same pass.

## 6. Idempotency & concurrency

- Each Dropbox folder is claimed exactly once via a `UNIQUE(source_path)` constraint on
  `dropbox_intake_batches` — repeated polling, a mid-process crash, or multiple Linki
  processes sharing the same database all resolve to the same row rather than racing.
- `batch_id` is separately unique (partial unique index) — the same `batch_id` reappearing
  under a different path is rejected as a conflict (with a clear message distinguishing
  "identical content, already handled" from "different content, refusing to process")
  instead of silently creating a second list or run.
- A run is only ever created once per batch: once `run_id` is recorded on the batch row,
  later passes skip straight to archiving instead of re-launching.
- If Linki restarts mid-batch, the next pass resumes from the batch's last recorded state
  (validate+import is safely re-run if it didn't finish; launch and archive are skipped if
  already recorded) rather than starting over or double-processing.

## 7. Running a pass

The background runner (already started via `instrumentation.ts` on every Linki server boot)
checks for new/ready batches on every tick, gated by `DROPBOX_INTAKE_POLL_INTERVAL_SECONDS`.
No separate process or second scheduler was introduced — this reuses the same loop that
already drives run steps and scheduled CSV imports (`lib/linkedin/runner.ts`).

For testing or operational recovery, run a single deterministic pass on demand:

```bash
npm run dropbox:intake
```

This calls the exact same code path as the background tick and prints a JSON summary
(scanned/completed/retryable/terminal counts). It works even if the Linki server isn't
running (it opens the database directly). The same pass is also available over HTTP as
`POST /api/dropbox/intake` (subject to normal Linki auth, like every other `/api/*` route)
for triggering from an external scheduler if you don't want to rely on the in-process runner.

## 8. Docker / self-hosted

No additional container or process is needed — set the `DROPBOX_INTAKE_*` environment
variables in your existing `docker-compose.yml` / deployment environment alongside the other
Linki env vars (`NEXTAUTH_SECRET`, `AUTH_PASSWORD`, etc.). The intake poller runs inside the
same Next.js server process. To run a one-off pass inside a running container:

```bash
docker compose exec linki npm run dropbox:intake
```

## 9. Troubleshooting

**"Dropbox authentication failed (invalid/expired token)"** — the refresh token was revoked
or the app's permissions changed. Re-run the OAuth flow in step 2 to get a fresh refresh
token; access tokens are re-derived automatically and never need manual renewal otherwise.

**"Dropbox rate limit exceeded"** — batches show up as `retryable_error` and are retried on
later passes; nothing to do unless it persists past 10 attempts (batch is then archived to
`/LinkiFailed` with the rate-limit error recorded). If this happens often, increase
`DROPBOX_INTAKE_POLL_INTERVAL_SECONDS`.

**A folder never gets picked up** — confirm `_READY` actually exists inside the batch
folder (not the root) and that it was uploaded *after* `campaign.json`/`contacts.csv`.
Folders without `_READY` are silently skipped every pass, by design.

**"batch_id ... conflicts with an existing batch"** — a `batch_id` must be globally unique
across every batch Linki has ever seen. Check `/LinkiProcessed` and `/LinkiFailed` for a
folder that already used this id, or have the upstream producer generate a new one.

**Nothing happens at all** — check `DROPBOX_INTAKE_ENABLED=true` and that all three of
`DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` are set; the feature is
silently a no-op otherwise (`npm run dropbox:intake` will print `"enabled": false` in that
case, which is the fastest way to check).

## 10. Example

See [`examples/dropbox-intake/`](../examples/dropbox-intake/) for a complete, ready-to-copy
batch folder fixture.
