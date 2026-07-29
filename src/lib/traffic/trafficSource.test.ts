// src/lib/traffic/trafficSource.test.ts
// GID 1216970103691946

import { resolveTrafficSource, TRAFFIC_SOURCE_HEADER } from "./trafficSource";

describe("resolveTrafficSource", () => {
  it("ヘッダ名は x-r2c-traffic-source", () => {
    expect(TRAFFIC_SOURCE_HEADER).toBe("x-r2c-traffic-source");
  });

  // ---- 必須テストケース(タスク指定) ----

  it("E2Eヘッダあり → 'e2e'", () => {
    expect(resolveTrafficSource({ headerValue: "e2e" })).toBe("e2e");
  });

  it("E2Eヘッダなし・UAのみ(HeadlessChrome) → 'e2e'", () => {
    expect(
      resolveTrafficSource({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      }),
    ).toBe("e2e");
  });

  it("E2Eヘッダなし・UAのみ(Playwright) → 'e2e'", () => {
    expect(resolveTrafficSource({ userAgent: "Playwright/1.40.0" })).toBe("e2e");
  });

  it("chat-test経由(isChatTestToken=true) → 'chat_test'", () => {
    expect(resolveTrafficSource({ isChatTestToken: true })).toBe("chat_test");
  });

  it("通常の実ブラウザリクエスト → 'user'", () => {
    expect(
      resolveTrafficSource({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        referer: "https://example-customer-site.com/shop",
      }),
    ).toBe("user");
  });

  // ---- デモ判定 ----

  it("Refererが/carnation-demo/を含む → 'demo'", () => {
    expect(resolveTrafficSource({ referer: "https://api.r2c.biz/carnation-demo/index.html" })).toBe("demo");
  });

  it("Refererが/lp/を含む → 'demo'", () => {
    expect(resolveTrafficSource({ referer: "https://r2c.biz/lp/" })).toBe("demo");
  });

  it("Refererが/lp(末尾スラッシュなし) → 'demo'", () => {
    expect(resolveTrafficSource({ referer: "https://r2c.biz/lp" })).toBe("demo");
  });

  it("Refererが実顧客サイトのパス(たまたま似た文字列を含まない) → 'user'", () => {
    expect(resolveTrafficSource({ referer: "https://mystore.example.com/products/lp-gas-heater" })).toBe("user");
  });

  // ---- 優先順位 ----

  it("isChatTestToken=trueが最優先(E2Eヘッダが同時にあってもchat_test)", () => {
    expect(
      resolveTrafficSource({ isChatTestToken: true, headerValue: "e2e", userAgent: "Playwright/1.40.0" }),
    ).toBe("chat_test");
  });

  it("明示的なE2Eヘッダはデモrefererより優先される", () => {
    expect(
      resolveTrafficSource({ headerValue: "e2e", referer: "https://r2c.biz/lp/" }),
    ).toBe("e2e");
  });

  it("UAベースのヘッドレス判定はデモrefererより優先される", () => {
    expect(
      resolveTrafficSource({ userAgent: "Playwright/1.40.0", referer: "https://r2c.biz/lp/" }),
    ).toBe("e2e");
  });

  // ---- 未設定・空値 ----

  it("何も渡さない場合は 'user'(デフォルト、既存セッションとの後方互換の要)", () => {
    expect(resolveTrafficSource({})).toBe("user");
  });

  it("空文字列のヘッダ値は無視される", () => {
    expect(resolveTrafficSource({ headerValue: "" })).toBe("user");
  });

  it("大文字小文字を区別しない(E2Eヘッダ)", () => {
    expect(resolveTrafficSource({ headerValue: "E2E" })).toBe("e2e");
  });
});
