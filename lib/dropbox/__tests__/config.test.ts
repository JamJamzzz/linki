import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDropboxIntakeConfig, normalizeDropboxRoot } from "@/lib/dropbox/config";

const ENV_KEYS = [
  "DROPBOX_INTAKE_ENABLED",
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
  "DROPBOX_INTAKE_ROOT",
  "DROPBOX_INTAKE_POLL_INTERVAL_SECONDS",
  "DROPBOX_INTAKE_MAX_ROWS",
];

describe("getDropboxIntakeConfig", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is disabled by default (unset)", () => {
    expect(getDropboxIntakeConfig()).toBeNull();
  });

  it("is disabled when DROPBOX_INTAKE_ENABLED=false", () => {
    process.env.DROPBOX_INTAKE_ENABLED = "false";
    process.env.DROPBOX_APP_KEY = "k";
    process.env.DROPBOX_APP_SECRET = "s";
    process.env.DROPBOX_REFRESH_TOKEN = "r";
    expect(getDropboxIntakeConfig()).toBeNull();
  });

  it("is disabled when enabled but credentials are incomplete", () => {
    process.env.DROPBOX_INTAKE_ENABLED = "true";
    process.env.DROPBOX_APP_KEY = "k";
    // app secret / refresh token missing
    expect(getDropboxIntakeConfig()).toBeNull();
  });

  it("resolves defaults when fully configured", () => {
    process.env.DROPBOX_INTAKE_ENABLED = "true";
    process.env.DROPBOX_APP_KEY = "k";
    process.env.DROPBOX_APP_SECRET = "s";
    process.env.DROPBOX_REFRESH_TOKEN = "r";
    const config = getDropboxIntakeConfig();
    expect(config).not.toBeNull();
    expect(config?.root).toBe("/LinkiInbox");
    expect(config?.pollIntervalSeconds).toBe(60);
    expect(config?.maxRows).toBe(500);
  });

  it("honors overrides", () => {
    process.env.DROPBOX_INTAKE_ENABLED = "true";
    process.env.DROPBOX_APP_KEY = "k";
    process.env.DROPBOX_APP_SECRET = "s";
    process.env.DROPBOX_REFRESH_TOKEN = "r";
    process.env.DROPBOX_INTAKE_ROOT = "MyInbox/";
    process.env.DROPBOX_INTAKE_POLL_INTERVAL_SECONDS = "120";
    process.env.DROPBOX_INTAKE_MAX_ROWS = "50";
    const config = getDropboxIntakeConfig();
    expect(config?.root).toBe("/MyInbox");
    expect(config?.pollIntervalSeconds).toBe(120);
    expect(config?.maxRows).toBe(50);
  });
});

describe("normalizeDropboxRoot", () => {
  it("rejects path traversal", () => {
    expect(normalizeDropboxRoot("/LinkiInbox/../etc")).toBeNull();
  });

  it("rejects the bare root", () => {
    expect(normalizeDropboxRoot("/")).toBeNull();
  });

  it("rejects the fixed archive roots", () => {
    expect(normalizeDropboxRoot("/LinkiProcessed")).toBeNull();
    expect(normalizeDropboxRoot("/LinkiFailed")).toBeNull();
  });

  it("adds a leading slash and strips a trailing one", () => {
    expect(normalizeDropboxRoot("LinkiInbox/")).toBe("/LinkiInbox");
  });
});
