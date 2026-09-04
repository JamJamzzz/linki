import { randomUUID } from "crypto";
import type DatabaseType from "better-sqlite3";
import type { DropboxIntakeConfig } from "@/lib/dropbox/config";

type DB = DatabaseType.Database;

export const ROOT = "/linkiinbox";

export function testConfig(overrides: Partial<DropboxIntakeConfig> = {}): DropboxIntakeConfig {
  return {
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    refreshToken: "test-refresh-token",
    root: ROOT,
    pollIntervalSeconds: 60,
    maxRows: 500,
    ...overrides,
  };
}

export function seedWorkflow(db: DB, track: "linkedin" | "email" = "linkedin"): string {
  const id = randomUUID();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, 'Test Workflow')").run(id);
  db.prepare(
    "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES (?, ?, 1, ?, ?)"
  ).run(randomUUID(), id, track === "email" ? "email" : "connect", track);
  return id;
}

export function seedLinkedInAccount(db: DB): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, 'Test Account', ?, 1)"
  ).run(id, `${id}@example.com`);
  return id;
}

export function seedEmailAccount(db: DB): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
     VALUES (?, 'Test Email', 'from@example.com', 'smtp.example.com', 'user', 'pass')`
  ).run(id);
  return id;
}

export interface ManifestOptions {
  batch_id?: string;
  list_name?: string;
  workflow_id?: string;
  linkedin_account_id?: string;
  email_account_id?: string;
  auto_launch?: boolean;
  schema_version?: number;
}

export function buildManifest(opts: ManifestOptions = {}): Record<string, unknown> {
  return {
    schema_version: opts.schema_version ?? 1,
    batch_id: opts.batch_id ?? "test-batch",
    list_name: opts.list_name ?? "Test List",
    ...(opts.workflow_id ? { workflow_id: opts.workflow_id } : {}),
    ...(opts.linkedin_account_id ? { linkedin_account_id: opts.linkedin_account_id } : {}),
    ...(opts.email_account_id ? { email_account_id: opts.email_account_id } : {}),
    ...(opts.auto_launch !== undefined ? { auto_launch: opts.auto_launch } : {}),
  };
}

export const LINKEDIN_ONLY_CSV = `linkedin_url,first_name,last_name\nhttps://www.linkedin.com/in/jane-doe/,Jane,Doe\nhttps://www.linkedin.com/in/john-smith/,John,Smith\n`;
export const EMAIL_ONLY_CSV = `email,first_name,last_name\njane@acme.com,Jane,Doe\njohn@acme.com,John,Smith\n`;
export const MIXED_CSV = `linkedin_url,email,first_name,last_name\nhttps://www.linkedin.com/in/jane-doe/,jane@acme.com,Jane,Doe\n,john@acme.com,John,Smith\n`;
export const INVALID_CSV = `first_name,last_name\nJane,Doe\nJohn,Smith\n`;

interface FakeDropboxModule {
  __reset(): void;
  __addFolder(p: string): void;
  __addFile(p: string, content: string): void;
  __exists(p: string): boolean;
  __readFile(p: string): string | undefined;
}

/** Seeds a ready (or not-yet-ready) batch folder under ROOT in the fake Dropbox store. */
export function seedBatchFolder(
  fake: FakeDropboxModule,
  name: string,
  manifest: Record<string, unknown>,
  csv: string,
  opts: { ready?: boolean } = {}
): string {
  const folderPath = `${ROOT}/${name}`;
  fake.__addFolder(folderPath);
  fake.__addFile(`${folderPath}/campaign.json`, JSON.stringify(manifest));
  fake.__addFile(`${folderPath}/contacts.csv`, csv);
  if (opts.ready !== false) fake.__addFile(`${folderPath}/_READY`, "");
  return folderPath;
}
