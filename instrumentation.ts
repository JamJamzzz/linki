export async function register() {
  // Only run on the Node.js server runtime, not in the browser/edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const [{ ensureGlobalRunnerStarted }, { startPersonalAutoEnroller }] = await Promise.all([
        import("@/lib/linkedin/runner"),
        import("@/lib/personal-auto"),
      ]);

      // Personal fork behavior: absorb every contact from every list into the
      // currently running campaign and queue it immediately.
      startPersonalAutoEnroller();
      ensureGlobalRunnerStarted();
    } catch (err) {
      console.error("[instrumentation] Failed to start background workers:", err);
    }
  }
}
