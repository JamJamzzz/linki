import { z } from "zod";
import type DatabaseType from "better-sqlite3";

type DB = DatabaseType.Database;

// campaign.json schema. schema_version is pinned to 1 — any other value (including a
// missing field) is rejected with a clear "unsupported schema version" error rather than
// silently guessing at a shape.
const ManifestShape = z.object({
  schema_version: z.number(),
  batch_id: z.string().min(1, "batch_id is required").regex(
    /^[A-Za-z0-9._-]+$/,
    "batch_id may only contain letters, numbers, '.', '_' and '-'"
  ),
  list_name: z.string().min(1, "list_name is required"),
  workflow_id: z.string().min(1).optional(),
  linkedin_account_id: z.string().min(1).optional(),
  email_account_id: z.string().min(1).optional(),
  auto_launch: z.boolean().optional().default(false),
});

export type CampaignManifest = z.infer<typeof ManifestShape>;

export interface ManifestValidationResult {
  ok: boolean;
  manifest?: CampaignManifest;
  errors: string[];
}

/** Parses and structurally validates campaign.json (schema only — no DB lookups). */
export function parseManifest(raw: string): ManifestValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`campaign.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, errors: ["campaign.json must be a JSON object"] };
  }

  const versionField = (json as Record<string, unknown>).schema_version;
  if (versionField !== 1) {
    return { ok: false, errors: [`Unsupported campaign.json schema_version: ${JSON.stringify(versionField)} (only version 1 is supported)`] };
  }

  const result = ManifestShape.safeParse(json);
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }

  const manifest = result.data;
  if (manifest.auto_launch && !manifest.workflow_id) {
    return { ok: false, errors: ["workflow_id is required when auto_launch is true"] };
  }
  // The existing POST /api/runs contract always requires a LinkedIn account_id on every
  // run (even email-only workflows) — see pages/api/runs/index.ts. Surface that constraint
  // here as a clear validation error instead of letting run creation fail opaquely later.
  if (manifest.auto_launch && !manifest.linkedin_account_id) {
    return { ok: false, errors: ["linkedin_account_id is required when auto_launch is true (Linki requires a LinkedIn account on every run)"] };
  }

  return { ok: true, manifest, errors: [] };
}

/**
 * Validates that referenced entities actually exist. Never guesses/falls back to an
 * arbitrary workflow or account — a missing or unauthenticated reference is a hard error.
 */
export function validateManifestReferences(db: DB, manifest: CampaignManifest): string[] {
  const errors: string[] = [];

  if (manifest.workflow_id) {
    const workflow = db.prepare("SELECT id, is_archived FROM workflows WHERE id = ?").get(manifest.workflow_id) as
      | { id: string; is_archived: number }
      | undefined;
    if (!workflow) errors.push(`workflow_id "${manifest.workflow_id}" does not exist`);
    else if (workflow.is_archived) errors.push(`workflow_id "${manifest.workflow_id}" is archived`);
  }

  if (manifest.linkedin_account_id) {
    const account = db.prepare("SELECT id FROM accounts WHERE id = ? AND is_authenticated = 1").get(manifest.linkedin_account_id);
    if (!account) errors.push(`linkedin_account_id "${manifest.linkedin_account_id}" does not exist or is not authenticated`);
  }

  if (manifest.email_account_id) {
    const account = db.prepare("SELECT id FROM email_accounts WHERE id = ?").get(manifest.email_account_id);
    if (!account) errors.push(`email_account_id "${manifest.email_account_id}" does not exist`);
  }

  return errors;
}
