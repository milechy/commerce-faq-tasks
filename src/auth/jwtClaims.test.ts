import { isAdminUsableToken } from "./jwtClaims";
import type { SupabaseJwtPayload } from "./verifySupabaseJwt";

function payload(overrides: Partial<SupabaseJwtPayload> & Record<string, unknown> = {}): SupabaseJwtPayload {
  return { sub: "user-1", ...overrides } as SupabaseJwtPayload;
}

describe("isAdminUsableToken", () => {
  it("rejects widget session tokens (purpose claim present)", () => {
    expect(
      isAdminUsableToken(payload({ purpose: "widget-session", tenant_id: "t1" }))
    ).toBe(false);
  });

  it("rejects chat-test tokens (purpose claim present)", () => {
    expect(
      isAdminUsableToken(payload({ purpose: "chat-test", tenant_id: "t1" }))
    ).toBe(false);
  });

  it("rejects top-level anon role", () => {
    expect(isAdminUsableToken(payload({ role: "anon" }))).toBe(false);
  });

  it("rejects app_metadata anon role", () => {
    expect(isAdminUsableToken(payload({ app_metadata: { role: "anon" } }))).toBe(false);
  });

  it("accepts app_metadata client_admin role", () => {
    expect(
      isAdminUsableToken(payload({ app_metadata: { role: "client_admin", tenant_id: "t1" } }))
    ).toBe(true);
  });

  it("accepts app_metadata super_admin role", () => {
    expect(isAdminUsableToken(payload({ app_metadata: { role: "super_admin" } }))).toBe(true);
  });

  it("rejects unknown/missing role", () => {
    expect(isAdminUsableToken(payload())).toBe(false);
    expect(isAdminUsableToken(payload({ app_metadata: { role: "unknown" } }))).toBe(false);
  });
});
