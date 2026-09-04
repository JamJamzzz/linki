import { describe, it, expect } from "vitest";
import { parseManifest } from "@/lib/dropbox/manifest";

describe("parseManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 1, batch_id: "abc-123", list_name: "My List" }));
    expect(result.ok).toBe(true);
    expect(result.manifest?.auto_launch).toBe(false);
  });

  it("rejects non-JSON input", () => {
    const result = parseManifest("not json");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not valid JSON/i);
  });

  it("rejects an unsupported schema_version", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 2, batch_id: "x", list_name: "y" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/schema_version/i);
  });

  it("rejects a missing batch_id", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 1, list_name: "y" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing list_name", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 1, batch_id: "x" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an unsafe batch_id", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 1, batch_id: "../../etc/passwd", list_name: "y" }));
    expect(result.ok).toBe(false);
  });

  it("requires workflow_id when auto_launch is true", () => {
    const result = parseManifest(JSON.stringify({ schema_version: 1, batch_id: "x", list_name: "y", auto_launch: true }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/workflow_id/);
  });

  it("requires linkedin_account_id when auto_launch is true", () => {
    const result = parseManifest(
      JSON.stringify({ schema_version: 1, batch_id: "x", list_name: "y", workflow_id: "wf-1", auto_launch: true })
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/linkedin_account_id/);
  });

  it("accepts a full manifest with auto_launch", () => {
    const result = parseManifest(
      JSON.stringify({
        schema_version: 1,
        batch_id: "ixl-swe-ng-31102",
        list_name: "IXL SWE New Grad",
        workflow_id: "wf-1",
        linkedin_account_id: "acct-1",
        email_account_id: "email-1",
        auto_launch: true,
      })
    );
    expect(result.ok).toBe(true);
  });

  it("preserves unknown upstream metadata being absent — extra fields are ignored, not rejected", () => {
    const result = parseManifest(
      JSON.stringify({ schema_version: 1, batch_id: "x", list_name: "y", job_id: "j-1", source: "gmail" })
    );
    expect(result.ok).toBe(true);
  });
});
