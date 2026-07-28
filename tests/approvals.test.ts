import { describe, expect, it } from "vitest";
import { approvalDecision, SESSION_APPROVAL_LABEL } from "../src/approvals.js";

describe("approval decisions", () => {
  it("uses the accurate session-scoped button label", () => {
    expect(SESSION_APPROVAL_LABEL).toBe("Allow for session");
  });

  it("uses Codex native session approval for commands", () => {
    expect(approvalDecision("command", "acceptForSession", {})).toEqual({ decision: "acceptForSession" });
  });

  it("grants only requested permissions at session scope", () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    expect(approvalDecision("permissions", "acceptForSession", { permissions })).toEqual({ permissions, scope: "session" });
  });
});
