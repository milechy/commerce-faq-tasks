import jwt from "jsonwebtoken";
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

  it("rejects when app_metadata itself is absent (not just role)", () => {
    const p = payload();
    delete (p as Record<string, unknown>).app_metadata;
    expect(isAdminUsableToken(p)).toBe(false);
  });

  // 型を偽装したペイロード (JWTは任意のJSONを積めるため、role が想定外の型で来ることは
  // 実運用でも起こりうる — 例外を投げず安全に false を返すことを固定する)
  it("does not throw and rejects when app_metadata.role is an array", () => {
    expect(() =>
      isAdminUsableToken(payload({ app_metadata: { role: ["super_admin"] as unknown as string } }))
    ).not.toThrow();
    expect(
      isAdminUsableToken(payload({ app_metadata: { role: ["super_admin"] as unknown as string } }))
    ).toBe(false);
  });

  it("does not throw and rejects when app_metadata.role is a number", () => {
    expect(
      isAdminUsableToken(payload({ app_metadata: { role: 1 as unknown as string } }))
    ).toBe(false);
  });

  it("does not throw and rejects when app_metadata itself is an unexpected type (string)", () => {
    expect(() =>
      isAdminUsableToken(payload({ app_metadata: "not-an-object" as unknown as SupabaseJwtPayload["app_metadata"] }))
    ).not.toThrow();
  });

  // tenant_id は isAdminUsableToken では判定しない（role のみを見る）が、
  // トップレベルとapp_metadataでtenant_idが矛盾するペイロードでもrole判定だけは
  // 揺らがないことを固定する。実際のtenant_id解決（どちらを採用するか）は
  // 呼び出し元(authMiddleware.ts / roleAuth.ts)の責務であり、ここでは検証しない。
  it("role judgement is unaffected by a top-level/app_metadata tenant_id mismatch", () => {
    expect(
      isAdminUsableToken(
        payload({ tenant_id: "tenant-a", app_metadata: { role: "client_admin", tenant_id: "tenant-b" } })
      )
    ).toBe(true);
  });
});

describe("verifySupabaseJwt", () => {
  const SECRET = "test-secret-for-verify-supabase-jwt";
  let verifySupabaseJwt: typeof import("./verifySupabaseJwt").verifySupabaseJwt;

  beforeAll(() => {
    // verifySupabaseJwt.ts はモジュールトップレベルで一度だけ process.env.SUPABASE_JWT_SECRET を
    // 読む実装のため、import前に環境変数を設定してから jest.isolateModules で新規ロードする。
    process.env.SUPABASE_JWT_SECRET = SECRET;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      verifySupabaseJwt = require("./verifySupabaseJwt").verifySupabaseJwt;
    });
  });

  function sign(payload: object, opts?: jwt.SignOptions, secret: string = SECRET) {
    return jwt.sign(payload, secret, { algorithm: "HS256", ...opts });
  }

  it("accepts a correctly-signed HS256 token with the configured secret", () => {
    const token = sign({ sub: "u1", app_metadata: { role: "client_admin", tenant_id: "t1" } });
    const result = verifySupabaseJwt(token);
    expect(result?.sub).toBe("u1");
    expect(result?.app_metadata?.role).toBe("client_admin");
  });

  it("rejects alg:none tokens (unsigned-token forgery)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "attacker", app_metadata: { role: "super_admin" } })
    ).toString("base64url");
    const forged = `${header}.${body}.`;
    expect(verifySupabaseJwt(forged)).toBeNull();
  });

  it("rejects tokens signed with a different secret (forgery with wrong key)", () => {
    const forged = sign({ sub: "attacker", app_metadata: { role: "super_admin" } }, undefined, "wrong-secret");
    expect(verifySupabaseJwt(forged)).toBeNull();
  });

  it("rejects a token whose payload was tampered with after signing", () => {
    const token = sign({ sub: "u1", app_metadata: { role: "client_admin" } });
    const [h, , s] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ sub: "u1", app_metadata: { role: "super_admin" } })
    ).toString("base64url");
    expect(verifySupabaseJwt(`${h}.${tamperedBody}.${s}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = sign({ sub: "u1" }, { expiresIn: -10 });
    expect(verifySupabaseJwt(token)).toBeNull();
  });

  it("accepts a token that expires 5s in the future (not-yet-expired boundary)", () => {
    const token = sign({ sub: "u1" }, { expiresIn: 5 });
    expect(verifySupabaseJwt(token)).not.toBeNull();
  });

  it("rejects malformed tokens without throwing (not a JWT at all)", () => {
    expect(() => verifySupabaseJwt("not-a-jwt")).not.toThrow();
    expect(verifySupabaseJwt("not-a-jwt")).toBeNull();
    expect(verifySupabaseJwt("a.b")).toBeNull(); // ドット区切りが2個しかない
    expect(verifySupabaseJwt("a.b.c.d")).toBeNull(); // ドット区切りが4個
  });

  it("rejects tokens with an invalid base64/JSON segment without throwing", () => {
    expect(() => verifySupabaseJwt("not-base64!!.also-not-base64!!.sig")).not.toThrow();
    expect(verifySupabaseJwt("not-base64!!.also-not-base64!!.sig")).toBeNull();
  });

  it("returns null (not throw) for empty string, undefined", () => {
    expect(() => verifySupabaseJwt("")).not.toThrow();
    expect(verifySupabaseJwt("")).toBeNull();
    expect(verifySupabaseJwt(undefined)).toBeNull();
  });

  it("does not accept RS256-header tokens signed with the HMAC secret as a MAC key (alg confusion)", () => {
    // アルゴリズム混同攻撃の典型形: ヘッダだけRS256に書き換え、HS256用の共有secretで
    // HMAC署名した偽トークンを作り、サーバがヘッダを信じてRS256公開鍵検証にフォールバック
    // しないことを確認する。algorithms:['HS256']固定のため、ヘッダのalgと不一致で拒否される。
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "attacker", app_metadata: { role: "super_admin" } })).toString(
      "base64url"
    );
    const crypto = require("crypto");
    const sig = crypto.createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
    const forged = `${header}.${body}.${sig}`;
    expect(verifySupabaseJwt(forged)).toBeNull();
  });
});
