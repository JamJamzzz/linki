import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

vi.mock("@/lib/dropbox/client", async () => await import("./fake-dropbox"));

import * as fake from "./fake-dropbox";
import { DropboxApiError } from "./fake-dropbox";
import {
  ROOT,
  testConfig,
  seedWorkflow,
  seedLinkedInAccount,
  buildManifest,
  seedBatchFolder,
  LINKEDIN_ONLY_CSV,
  EMAIL_ONLY_CSV,
  MIXED_CSV,
  INVALID_CSV,
} from "./helpers";

// Loose row shape for asserting on raw SQLite query results in tests, instead of `any`.
type Row = Record<string, string | number | null>;
function asRow(x: unknown): Row {
  return x as Row;
}
function asRows(x: unknown): Row[] {
  return x as Row[];
}

let createDatabase: typeof import("@/lib/db").createDatabase;
let runDropboxIntakeOnce: typeof import("@/lib/dropbox/intake").runDropboxIntakeOnce;
let getDropboxIntakeConfig: typeof import("@/lib/dropbox/config").getDropboxIntakeConfig;

beforeAll(async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret";
  ({ createDatabase } = await import("@/lib/db"));
  ({ runDropboxIntakeOnce } = await import("@/lib/dropbox/intake"));
  ({ getDropboxIntakeConfig } = await import("@/lib/dropbox/config"));
});

function freshDb() {
  return createDatabase(":memory:");
}

beforeEach(() => {
  fake.__reset();
  fake.__addFolder(ROOT);
});

describe("disabled configuration", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  it("getDropboxIntakeConfig returns null when DROPBOX_INTAKE_ENABLED is unset", () => {
    delete process.env.DROPBOX_INTAKE_ENABLED;
    expect(getDropboxIntakeConfig()).toBeNull();
  });

  it("getDropboxIntakeConfig returns null when enabled=true but credentials are missing", () => {
    process.env.DROPBOX_INTAKE_ENABLED = "true";
    delete process.env.DROPBOX_APP_KEY;
    expect(getDropboxIntakeConfig()).toBeNull();
  });

  it("runDropboxIntakeOnce is a safe no-op when disabled", async () => {
    process.env.DROPBOX_INTAKE_ENABLED = "false";
    const db = freshDb();
    const summary = await runDropboxIntakeOnce(db);
    expect(summary.enabled).toBe(false);
    expect(summary.scanned).toBe(0);
  });
});

describe("valid batch import", () => {
  it("imports LinkedIn-only contacts and creates a list", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    seedBatchFolder(fake, "batch-li", buildManifest({ batch_id: "b-li", workflow_id: workflowId, auto_launch: false }), LINKEDIN_ONLY_CSV);

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-li'").get());
    expect(row.status).toBe("completed");
    expect(row.imported_count).toBe(2);

    const list = asRow(db.prepare("SELECT * FROM lists WHERE id = ?").get(row.list_id));
    expect(list.name).toBe("Test List");
    const count = (asRow(db.prepare("SELECT COUNT(*) c FROM list_targets WHERE list_id = ?").get(row.list_id))).c;
    expect(count).toBe(2);
  });

  it("imports email-only contacts", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-email", buildManifest({ batch_id: "b-email", auto_launch: false }), EMAIL_ONLY_CSV);

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);
    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-email'").get());
    expect(row.imported_count).toBe(2);
  });

  it("imports mixed LinkedIn + email contacts", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-mixed", buildManifest({ batch_id: "b-mixed", auto_launch: false }), MIXED_CSV);

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);
    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-mixed'").get());
    expect(row.imported_count).toBe(2);
  });

  it("reuses an existing list when list_name already exists", async () => {
    const db = freshDb();
    const existingListId = randomUUID();
    db.prepare("INSERT INTO lists (id, name) VALUES (?, 'Shared List')").run(existingListId);

    seedBatchFolder(fake, "batch-reuse", buildManifest({ batch_id: "b-reuse", list_name: "Shared List", auto_launch: false }), LINKEDIN_ONLY_CSV);
    await runDropboxIntakeOnce(db, testConfig());

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-reuse'").get());
    expect(row.list_id).toBe(existingListId);
  });
});

describe("auto_launch", () => {
  it("launches the specified workflow exactly once", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    const accountId = seedLinkedInAccount(db);
    seedBatchFolder(
      fake,
      "batch-launch",
      buildManifest({ batch_id: "b-launch", workflow_id: workflowId, linkedin_account_id: accountId, auto_launch: true }),
      LINKEDIN_ONLY_CSV
    );

    await runDropboxIntakeOnce(db, testConfig());

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-launch'").get());
    expect(row.status).toBe("completed");
    expect(row.run_id).toBeTruthy();
    const run = asRow(db.prepare("SELECT * FROM runs WHERE id = ?").get(row.run_id));
    expect(run.status).toBe("running");
    expect(run.workflow_id).toBe(workflowId);

    const runCount = (asRow(db.prepare("SELECT COUNT(*) c FROM runs WHERE workflow_id = ?").get(workflowId))).c;
    expect(runCount).toBe(1);
  });

  it("does not launch when auto_launch is false", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    seedBatchFolder(fake, "batch-nolaunch", buildManifest({ batch_id: "b-nolaunch", workflow_id: workflowId, auto_launch: false }), LINKEDIN_ONLY_CSV);

    await runDropboxIntakeOnce(db, testConfig());
    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-nolaunch'").get());
    expect(row.status).toBe("completed");
    expect(row.run_id).toBeNull();
  });
});

describe("malformed manifest", () => {
  it("rejects invalid JSON and moves the folder to LinkiFailed", async () => {
    const db = freshDb();
    const folderPath = `${ROOT}/bad-json`;
    fake.__addFolder(folderPath);
    fake.__addFile(`${folderPath}/campaign.json`, "{ not valid json");
    fake.__addFile(`${folderPath}/contacts.csv`, LINKEDIN_ONLY_CSV);
    fake.__addFile(`${folderPath}/_READY`, "");

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
    expect(fake.__exists(folderPath)).toBe(false);
    expect(fake.__exists("/linkifailed/bad-json")).toBe(true);
    expect(fake.__exists("/linkifailed/bad-json/result.json")).toBe(true);
  });

  it("rejects an unsupported schema_version", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "bad-version", buildManifest({ schema_version: 2, batch_id: "b-v2" }), LINKEDIN_ONLY_CSV);
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE source_path = ?").get(`${ROOT}/bad-version`));
    expect(row.status).toBe("terminal_error");
    expect(row.error).toMatch(/schema_version/i);
  });

  it("requires workflow_id when auto_launch is true", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "bad-autolaunch", buildManifest({ batch_id: "b-al", auto_launch: true }), LINKEDIN_ONLY_CSV);
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
  });
});

describe("missing _READY", () => {
  it("is skipped without error and without being archived", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "not-ready", buildManifest({ batch_id: "b-notready" }), LINKEDIN_ONLY_CSV, { ready: false });
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.notReady).toBe(1);
    expect(summary.terminalErrors).toBe(0);
    expect(fake.__exists(`${ROOT}/not-ready`)).toBe(true);
  });
});

describe("missing required files", () => {
  it("terminal-errors when contacts.csv is missing", async () => {
    const db = freshDb();
    const folderPath = `${ROOT}/no-csv`;
    fake.__addFolder(folderPath);
    fake.__addFile(`${folderPath}/campaign.json`, JSON.stringify(buildManifest({ batch_id: "b-nocsv" })));
    fake.__addFile(`${folderPath}/_READY`, "");
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
    expect(fake.__exists("/linkifailed/no-csv")).toBe(true);
  });

  it("terminal-errors when campaign.json is missing", async () => {
    const db = freshDb();
    const folderPath = `${ROOT}/no-manifest`;
    fake.__addFolder(folderPath);
    fake.__addFile(`${folderPath}/contacts.csv`, LINKEDIN_ONLY_CSV);
    fake.__addFile(`${folderPath}/_READY`, "");
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
  });
});

describe("invalid contacts", () => {
  it("imports zero contacts and records row errors when no row has linkedin_url or email", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-invalid", buildManifest({ batch_id: "b-invalid", auto_launch: false }), INVALID_CSV);
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1); // the batch itself is well-formed; bad rows are isolated
    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-invalid'").get());
    expect(row.imported_count).toBe(0);
    expect(row.failed_count).toBe(2);
  });
});

describe("nonexistent workflow/account", () => {
  it("terminal-errors on a nonexistent workflow_id", async () => {
    const db = freshDb();
    const accountId = seedLinkedInAccount(db);
    seedBatchFolder(
      fake,
      "batch-badworkflow",
      buildManifest({ batch_id: "b-badwf", workflow_id: "does-not-exist", linkedin_account_id: accountId, auto_launch: true }),
      LINKEDIN_ONLY_CSV
    );
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
  });

  it("terminal-errors on a nonexistent linkedin_account_id", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    seedBatchFolder(
      fake,
      "batch-badaccount",
      buildManifest({ batch_id: "b-badacct", workflow_id: workflowId, linkedin_account_id: "does-not-exist", auto_launch: true }),
      LINKEDIN_ONLY_CSV
    );
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
  });

  it("terminal-errors on a nonexistent email_account_id", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-bademail", buildManifest({ batch_id: "b-bademail", email_account_id: "does-not-exist", auto_launch: false }), LINKEDIN_ONLY_CSV);
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);
  });
});

describe("idempotency and concurrency", () => {
  it("does not reprocess the same folder on repeated polling", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-repeat", buildManifest({ batch_id: "b-repeat", auto_launch: false }), LINKEDIN_ONLY_CSV);

    const first = await runDropboxIntakeOnce(db, testConfig());
    expect(first.completed).toBe(1);

    // Folder has moved to LinkiProcessed, so a second poll of the root sees nothing new.
    const second = await runDropboxIntakeOnce(db, testConfig());
    expect(second.scanned).toBe(0);

    const rows = asRow(db.prepare("SELECT COUNT(*) c FROM dropbox_intake_batches WHERE batch_id = 'b-repeat'").get());
    expect(rows.c).toBe(1);
  });

  it("rejects a duplicate batch_id observed at a different path", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-dup-a", buildManifest({ batch_id: "b-dup", auto_launch: false }), LINKEDIN_ONLY_CSV, { ready: false });
    seedBatchFolder(fake, "batch-dup-b", buildManifest({ batch_id: "b-dup", auto_launch: false }), LINKEDIN_ONLY_CSV, { ready: false });
    // Mark both ready in the same pass so they race for the same batch_id.
    fake.__addFile(`${ROOT}/batch-dup-a/_READY`, "");
    fake.__addFile(`${ROOT}/batch-dup-b/_READY`, "");

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);
    expect(summary.terminalErrors).toBe(1);

    const owners = asRows(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id = 'b-dup'").all());
    expect(owners.length).toBe(1); // only the first claimant kept the batch_id
  });

  it("rejects a duplicate batch_id with conflicting content", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-conflict-a", buildManifest({ batch_id: "b-conflict", auto_launch: false }), LINKEDIN_ONLY_CSV);
    await runDropboxIntakeOnce(db, testConfig()); // completes and archives batch-conflict-a

    seedBatchFolder(fake, "batch-conflict-b", buildManifest({ batch_id: "b-conflict", auto_launch: false }), EMAIL_ONLY_CSV);
    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.terminalErrors).toBe(1);

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE source_path = ?").get(`${ROOT}/batch-conflict-b`));
    expect(row.status).toBe("terminal_error");
    expect(row.error).toMatch(/conflict/i);
  });

  it("simulates a crash after import but before launch, then resumes without re-importing or double-launching", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    const accountId = seedLinkedInAccount(db);
    seedBatchFolder(
      fake,
      "batch-crash",
      buildManifest({ batch_id: "b-crash", workflow_id: workflowId, linkedin_account_id: accountId, auto_launch: true }),
      LINKEDIN_ONLY_CSV
    );

    // Simulate "imported but not yet launched" by pre-seeding the row directly, as if a
    // previous process had gotten this far before crashing.
    const rowId = randomUUID();
    const listId = randomUUID();
    db.prepare("INSERT INTO lists (id, name) VALUES (?, 'Test List')").run(listId);
    // Simulate importCsv having already run: targets + list_targets exist, as they would
    // after a completed import step that crashed before the launch step ran.
    const targetId = randomUUID();
    db.prepare("INSERT INTO targets (id, linkedin_url, first_name, last_name) VALUES (?, ?, 'Jane', 'Doe')").run(
      targetId,
      "https://www.linkedin.com/in/jane-doe/"
    );
    db.prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(listId, targetId);
    db.prepare(
      `INSERT INTO dropbox_intake_batches (id, source_path, batch_id, status, manifest_json, list_id, imported_count)
       VALUES (?, ?, 'b-crash', 'imported', ?, ?, 2)`
    ).run(
      rowId,
      `${ROOT}/batch-crash`,
      JSON.stringify(buildManifest({ batch_id: "b-crash", workflow_id: workflowId, linkedin_account_id: accountId, auto_launch: true })),
      listId
    );

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);

    const runCount = (asRow(db.prepare("SELECT COUNT(*) c FROM runs WHERE workflow_id = ?").get(workflowId))).c;
    expect(runCount).toBe(1); // not double-launched

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE id = ?").get(rowId));
    expect(row.status).toBe("completed");
    expect(row.run_id).toBeTruthy();
  });

  it("two concurrent claims on the same path resolve to one row", () => {
    const db = freshDb();
    const sourcePath = `${ROOT}/concurrent`;
    // Directly exercise the UNIQUE(source_path) constraint the way two racing workers would.
    const insert = () => {
      try {
        db.prepare("INSERT INTO dropbox_intake_batches (id, source_path, status) VALUES (?, ?, 'discovered')").run(randomUUID(), sourcePath);
        return true;
      } catch {
        return false;
      }
    };
    expect(insert()).toBe(true);
    expect(insert()).toBe(false); // second worker's claim is rejected by the DB, not a race in app code
    const rows = asRows(db.prepare("SELECT * FROM dropbox_intake_batches WHERE source_path = ?").all(sourcePath));
    expect(rows.length).toBe(1);
  });
});

describe("Dropbox rate limiting / transient failures", () => {
  it("marks the batch retryable_error and leaves the folder in place", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-ratelimited", buildManifest({ batch_id: "b-rl", auto_launch: false }), LINKEDIN_ONLY_CSV);
    fake.__queueFailure("downloadText", new DropboxApiError("rate limited", "rate_limit", true, 5000));

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.retryableErrors).toBe(1);
    expect(fake.__exists(`${ROOT}/batch-ratelimited`)).toBe(true); // NOT moved to Failed

    const row = asRow(db.prepare("SELECT * FROM dropbox_intake_batches WHERE batch_id IS NULL AND source_path = ?").get(`${ROOT}/batch-ratelimited`));
    expect(row.status).toBe("retryable_error");
    expect(row.retry_count).toBe(1);
  });

  it("recovers on the next pass once the transient failure clears", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-recovers", buildManifest({ batch_id: "b-recover", auto_launch: false }), LINKEDIN_ONLY_CSV);
    fake.__queueFailure("downloadText", new DropboxApiError("network blip", "network", true));

    const first = await runDropboxIntakeOnce(db, testConfig());
    expect(first.retryableErrors).toBe(1);

    const second = await runDropboxIntakeOnce(db, testConfig());
    expect(second.completed).toBe(1);
  });
});

describe("terminal failure isolation", () => {
  it("one invalid batch does not block other batches in the same pass", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-good", buildManifest({ batch_id: "b-good", auto_launch: false }), LINKEDIN_ONLY_CSV);
    seedBatchFolder(fake, "batch-bad", buildManifest({ schema_version: 99, batch_id: "b-bad" }), LINKEDIN_ONLY_CSV);

    const summary = await runDropboxIntakeOnce(db, testConfig());
    expect(summary.completed).toBe(1);
    expect(summary.terminalErrors).toBe(1);
  });
});

describe("archiving", () => {
  it("archives a successful batch under LinkiProcessed with a result.json", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-archive-ok", buildManifest({ batch_id: "b-archive-ok", auto_launch: false }), LINKEDIN_ONLY_CSV);
    await runDropboxIntakeOnce(db, testConfig());

    expect(fake.__exists(`${ROOT}/batch-archive-ok`)).toBe(false);
    expect(fake.__exists("/linkiprocessed/batch-archive-ok")).toBe(true);
    const result = JSON.parse(fake.__readFile("/linkiprocessed/batch-archive-ok/result.json")!);
    expect(result.status).toBe("completed");
    expect(result.batch_id).toBe("b-archive-ok");
  });

  it("archives a failed batch under LinkiFailed with a result.json", async () => {
    const db = freshDb();
    seedBatchFolder(fake, "batch-archive-fail", buildManifest({ schema_version: 7, batch_id: "b-archive-fail" }), LINKEDIN_ONLY_CSV);
    await runDropboxIntakeOnce(db, testConfig());

    expect(fake.__exists(`${ROOT}/batch-archive-fail`)).toBe(false);
    expect(fake.__exists("/linkifailed/batch-archive-fail")).toBe(true);
    const result = JSON.parse(fake.__readFile("/linkifailed/batch-archive-fail/result.json")!);
    expect(result.status).toBe("terminal_error");
  });
});

describe("no duplicate campaign launch", () => {
  it("a second pass after completion never creates a second run", async () => {
    const db = freshDb();
    const workflowId = seedWorkflow(db);
    const accountId = seedLinkedInAccount(db);
    seedBatchFolder(
      fake,
      "batch-onelaunch",
      buildManifest({ batch_id: "b-onelaunch", workflow_id: workflowId, linkedin_account_id: accountId, auto_launch: true }),
      LINKEDIN_ONLY_CSV
    );

    await runDropboxIntakeOnce(db, testConfig());
    await runDropboxIntakeOnce(db, testConfig());
    await runDropboxIntakeOnce(db, testConfig());

    const runCount = (asRow(db.prepare("SELECT COUNT(*) c FROM runs WHERE workflow_id = ?").get(workflowId))).c;
    expect(runCount).toBe(1);
  });
});
