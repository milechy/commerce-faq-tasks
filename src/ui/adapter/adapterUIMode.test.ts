import type { AdapterStatus } from "@/api/contracts/agentDialog";
import { toAvatarUIMode } from "./adapterUIMode";

describe("toAvatarUIMode", () => {
  it("returns hidden when status is undefined", () => {
    expect(toAvatarUIMode(undefined)).toBe("hidden");
  });

  it("maps disabled-like statuses to disabled", () => {
    const cases: AdapterStatus[] = ["disabled", "skipped_pii"];
    for (const s of cases) {
      expect(toAvatarUIMode(s)).toBe("disabled");
    }
  });

  it("maps requested to connecting", () => {
    expect(toAvatarUIMode("requested")).toBe("connecting");
  });

  it("maps failed to failed", () => {
    expect(toAvatarUIMode("failed")).toBe("failed");
  });

  it("maps fallback to fallback", () => {
    expect(toAvatarUIMode("fallback")).toBe("fallback");
  });

  it("is failure-tolerant for unknown status (casts)", () => {
    expect(toAvatarUIMode("unknown_future_status" as any)).toBe("hidden");
  });
});
