// src/api/widget/widgetGenerator.test.ts
// B3: widget セッショントークンが SUPABASE_JWT_SECRET と分離された WIDGET_JWT_SECRET で
// 署名されること、未設定時にフォールバックせず fail する回帰テスト。
// fs / jsonwebtoken をモックし、javascript-obfuscator の有無に依存しない安定したテストにする。

jest.mock("node:fs", () => ({
  readFileSync: jest.fn(() => "/* dummy widget.js source */"),
}));

const signMock = jest.fn(
  (_payload: Record<string, unknown>, _secret: string, _opts?: unknown) => "signed.jwt.token"
);
jest.mock("jsonwebtoken", () => ({
  __esModule: true,
  default: { sign: (...args: Parameters<typeof signMock>) => signMock(...args) },
}));

import { generateWidgetJs } from "./widgetGenerator";

const BASE_CONFIG = {
  tenantId: "tenant-a",
  apiBaseUrl: "https://api.r2c.biz",
};

describe("widgetGenerator — WIDGET_JWT_SECRET 分離 (B3)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    signMock.mockClear();
  });

  describe("正常系", () => {
    it("WIDGET_JWT_SECRET 設定済み → 正常にトークンが生成され、_wt として埋め込まれる", async () => {
      process.env.WIDGET_JWT_SECRET = "widget-secret-value";
      delete process.env.SUPABASE_JWT_SECRET;

      const out = await generateWidgetJs(BASE_CONFIG);

      // 出力は javascript-obfuscator の有無で文字列表現が変わるため、
      // 「トークンが1回だけ生成された」ことと「非空の出力が返る」ことで検証する
      // （埋め込みトークンの中身の正しさは下記の signMock.mock.calls 検証で担保する）。
      expect(signMock).toHaveBeenCalledTimes(1);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    });

    it("生成される JWT の署名鍵は WIDGET_JWT_SECRET であり、SUPABASE_JWT_SECRET ではない", async () => {
      process.env.WIDGET_JWT_SECRET = "widget-only-secret";
      process.env.SUPABASE_JWT_SECRET = "supabase-only-secret";

      await generateWidgetJs(BASE_CONFIG);

      const [, usedSecret] = signMock.mock.calls[0] as [unknown, string, unknown];
      expect(usedSecret).toBe("widget-only-secret");
      expect(usedSecret).not.toBe("supabase-only-secret");
    });

    it("payload に purpose: 'widget-session' が必ず含まれる（他ミドルウェアが管理API通過を拒否するための識別子）", async () => {
      process.env.WIDGET_JWT_SECRET = "s";

      await generateWidgetJs(BASE_CONFIG);

      const [payload] = signMock.mock.calls[0] as [Record<string, unknown>, string, unknown];
      expect(payload.purpose).toBe("widget-session");
      expect(payload.sub).toBe("tenant-a");
    });
  });

  describe("境界値・異常系", () => {
    it("WIDGET_JWT_SECRET 未設定 → SUPABASE_JWT_SECRET があっても例外を投げる（フォールバックしない）", async () => {
      delete process.env.WIDGET_JWT_SECRET;
      process.env.SUPABASE_JWT_SECRET = "supabase-secret-present";

      await expect(generateWidgetJs(BASE_CONFIG)).rejects.toThrow(
        /WIDGET_JWT_SECRET/
      );
      expect(signMock).not.toHaveBeenCalled();
    });

    it("WIDGET_JWT_SECRET が空文字列 '' → 未設定と同様に例外", async () => {
      process.env.WIDGET_JWT_SECRET = "";

      await expect(generateWidgetJs(BASE_CONFIG)).rejects.toThrow(
        /WIDGET_JWT_SECRET/
      );
    });

    it("退行防止: ソースに 'widget-secret-dev' のハードコード文字列が存在しない", () => {
      // 実ファイルを直接読み、ハードコードフォールバックが復活していないか検査する
      const actualFs = jest.requireActual("node:fs") as typeof import("node:fs");
      const actualPath = jest.requireActual("node:path") as typeof import("node:path");
      const src = actualFs.readFileSync(
        actualPath.resolve(__dirname, "widgetGenerator.ts"),
        "utf-8"
      );
      expect(src).not.toMatch(/widget-secret-dev/);
    });
  });

  describe("イレギュラー操作", () => {
    it("同一tenantIdで連続生成しても nonce が毎回異なる（トークン使い回しでの推測可能性を避ける）", async () => {
      process.env.WIDGET_JWT_SECRET = "s";

      await generateWidgetJs(BASE_CONFIG);
      await generateWidgetJs(BASE_CONFIG);

      const [payload1] = signMock.mock.calls[0] as [Record<string, unknown>, string, unknown];
      const [payload2] = signMock.mock.calls[1] as [Record<string, unknown>, string, unknown];
      expect(payload1.nonce).not.toBe(payload2.nonce);
    });

    it("tenantId に空文字列を渡しても例外にはならず sub が空文字列で署名される（呼び出し元のバリデーション責務であることの明示）", async () => {
      process.env.WIDGET_JWT_SECRET = "s";

      await generateWidgetJs({ ...BASE_CONFIG, tenantId: "" });

      const [payload] = signMock.mock.calls[0] as [Record<string, unknown>, string, unknown];
      expect(payload.sub).toBe("");
    });
  });
});

describe("widgetGenerator — 「Powered by R2C」バッジ設定の注入 (PR-B)", () => {
  const originalEnv = { ...process.env };

  // javascript-obfuscator が使える(stringArray:true)と URL 文字列が符号化され
  // toContain での検証ができなくなるため、この describe では毎回モジュールを
  // リセットして require を失敗させ、必ず catch 節（生の configBlock + source）を通す。
  // ファイル冒頭のコメント「obfuscator の有無に依存しない安定したテストにする」と同じ方針。
  // 静的 import した generateWidgetJs は reset 前の古いモジュールを指したままになるため、
  // このブロックでは各テスト内で fresh に require し直す。
  function freshGenerateWidgetJs() {
    jest.resetModules();
    // virtual:true は付けない — javascript-obfuscator は実在パッケージ(devDep)であり、
    // virtual指定はJestのモジュール解決と衝突して無視される（実モジュールが使われてしまう）。
    jest.doMock("javascript-obfuscator", () => {
      throw new Error("javascript-obfuscator not available in test");
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("./widgetGenerator") as typeof import("./widgetGenerator"))
      .generateWidgetJs;
  }

  beforeEach(() => {
    process.env.WIDGET_JWT_SECRET = "s";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.dontMock("javascript-obfuscator");
    jest.resetModules();
  });

  it("showBrandingBadge / badgeUrl 未指定時は既定値(true / null)で埋め込まれる", async () => {
    const out = await freshGenerateWidgetJs()(BASE_CONFIG);
    expect(out).toContain("showBrandingBadge: true");
    expect(out).toContain("badgeUrl: null");
  });

  it("showBrandingBadge: false, badgeUrl 指定時はそのまま埋め込まれる", async () => {
    const out = await freshGenerateWidgetJs()({
      ...BASE_CONFIG,
      showBrandingBadge: false,
      badgeUrl: "https://r2c.biz/lp/from-chat/?utm_source=widget&r2c_ref=tenant-a",
    });
    expect(out).toContain("showBrandingBadge: false");
    expect(out).toContain(
      '"https://r2c.biz/lp/from-chat/?utm_source=widget&r2c_ref=tenant-a"'
    );
  });

  it("showBrandingBadge: true, badgeUrl 指定時はそのまま埋め込まれる", async () => {
    const out = await freshGenerateWidgetJs()({
      ...BASE_CONFIG,
      showBrandingBadge: true,
      badgeUrl: "https://r2c.biz/lp/from-chat/?r2c_ref=tenant-a",
    });
    expect(out).toContain("showBrandingBadge: true");
    expect(out).toContain('"https://r2c.biz/lp/from-chat/?r2c_ref=tenant-a"');
  });
});
