import { buildTenantSessionKey } from "./sessionKey";

describe("buildTenantSessionKey", () => {
  it("tenantIdとsessionIdを`::`で連結する", () => {
    expect(buildTenantSessionKey("tenant-a", "session-1")).toBe("tenant-a::session-1");
  });

  it("tenantIdに`::`が含まれる場合は例外を投げる", () => {
    expect(() => buildTenantSessionKey("A::B", "C")).toThrow(/tenantId must not contain/);
  });

  it("sessionIdに`::`が含まれてもtenantIdがコロンを含まなければ例外を投げない（境界はtenantId側の不変条件で守られる）", () => {
    expect(buildTenantSessionKey("A", "B::C")).toBe("A::B::C");
  });

  it("tenantIdの単一コロンは許可する（`::`の二重コロンのみを検知する）", () => {
    expect(buildTenantSessionKey("tenant:demo", "s1")).toBe("tenant:demo::s1");
  });
});

// flowContextStore が buildTenantSessionKey を経由することの検証は
// ./flowContextStore.test.ts に集約した（contextStore / salesContextStore は
// PR #819 で統一済み。flowContextStore は #837 で追随し、専用テストファイルが
// 無かったためこのファイルに間借りしていたが、ここに移動した）。
