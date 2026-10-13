import { describe, test, expect } from "bun:test";
import { watcherNotificationNudge, watcherDeathNotice } from "../src/prompts";
import { URL } from "./mocks/watchers-harness";

// ---------------------------------------------------------------------------
// watcherNotificationNudge
// ---------------------------------------------------------------------------

describe("watcherNotificationNudge", () => {
  const events = [
    { type: "pr_ci", summary: 'check "CI" completed (success)', url: "https://example.com/ci" },
    { type: "pr_comment", summary: "comment by alice", url: "https://example.com/c" },
  ];

  test("renders event summaries and the greenlit-work continuation exception", () => {
    const text = watcherNotificationNudge("acme/widgets#7", events);
    expect(text).toContain('- pr_ci: check "CI" completed (success) https://example.com/ci');
    expect(text).toContain("- pr_comment: comment by alice https://example.com/c");
    expect(text).toContain("not approval to advance other pending work");
    expect(text).toContain("gate work the user already greenlit");
    expect(text).toContain("conclusions are in the summaries above");
  });

  test("cadence line appears only when pollSeconds is passed", () => {
    expect(watcherNotificationNudge("acme/widgets#7", events, 60)).toContain("polled every ~60s");
    expect(watcherNotificationNudge("acme/widgets#7", events)).not.toContain("polled every");
  });

  test("command events render without a dangling URL and with the command detail hint", () => {
    const text = watcherNotificationNudge("test -f /tmp/marker", [
      { type: "command_success", summary: "command exited 0 (took 1.2s)", url: "" },
    ]);
    expect(text).toContain("- command_success: command exited 0 (took 1.2s)");
    expect(text).not.toMatch(/1\.2s\s+$/m);
    expect(text).toContain("re-run it or read logs yourself");
    expect(text).not.toContain("conclusions are in the summaries above");
  });

  test("watcherDeathNotice carries the dead session's identity when known", () => {
    const text = watcherDeathNotice(["acme/widgets#7"], { name: "rosie-unit-one-00007", sessionID: "ses_ee7ec0" });
    expect(text).toContain("acme/widgets#7");
    expect(text).toContain("Dead session: rosie-unit-one-00007 (ses_ee7ec0)");
    expect(text).toContain("re-arm automatically");
    // Without the owner the notice stays as it was.
    expect(watcherDeathNotice(["acme/widgets#7"])).not.toContain("Dead session");
  });

  test("watcherDeathNotice says cancelled for the sessionDied path (no automatic re-arm)", () => {
    // The confirmed-death path DELETES the watchers - the notice must not
    // promise a resume re-arm that will never happen.
    const text = watcherDeathNotice(["acme/widgets#7"], { name: "rosie-unit-one-00007", sessionID: "ses_ee7ec0" }, { rearmsOnResume: false });
    expect(text).toContain("was cancelled when the session died");
    expect(text).toContain("watch_create");
    expect(text).not.toContain("re-arm automatically");
    const plural = watcherDeathNotice(["acme/widgets#7", "acme/widgets#8"], undefined, { rearmsOnResume: false });
    expect(plural).toContain("were cancelled when the session died");
    expect(plural).toContain("re-create them");
  });

  test("an all-expiry delivery uses the expiry framing and drops the gating carve-out", () => {    const text = watcherNotificationNudge("acme/widgets#7", [
      { type: "watch_expired", summary: "watch on acme/widgets#7 expired after 480 min - no further notifications will arrive from it", url: URL },
    ]);
    expect(text).toContain("- watch_expired: watch on acme/widgets#7 expired after 480 min");
    expect(text).toContain("not a completion signal");
    expect(text).toContain("Re-register the watch");
    // The continuation carve-out must never appear on an expiry notice: the
    // watched condition did not occur, so this is never a signal to proceed.
    expect(text).not.toContain("continuation signal");
  });
});
