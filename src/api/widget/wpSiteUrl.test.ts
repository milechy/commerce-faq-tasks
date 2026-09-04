// src/api/widget/wpSiteUrl.test.ts
//
// 要件書 docs/WORDPRESS_PLUGIN_REQUIREMENTS.md の以下を固定する:
//   X-9  サイトURLのスキーム/末尾スラッシュ/www/ポートのゆれ
//   I-1  ドメイン変更(http→https, www有無)でウィジェットが無言で止まる
//   I-9  localhost / 内部IP のローカル開発環境から接続しようとする

import { normalizeWpSiteUrl, isNonPublicHostname, buildWpTenantId } from "./wpSiteUrl";

describe("normalizeWpSiteUrl — 正常系", () => {
  it.each([
    ["そのまま", "https://example.com", "https://example.com"],
    ["末尾スラッシュを落とす", "https://example.com/", "https://example.com"],
    ["サブディレクトリ設置のパスを落とす", "https://example.com/blog", "https://example.com"],
    ["クエリとフラグメントを落とす", "https://example.com/blog/?p=1#top", "https://example.com"],
    ["ホスト名を小文字化する", "https://EXAMPLE.CoM/", "https://example.com"],
    ["前後の空白を無視する", "  https://example.com  ", "https://example.com"],
    ["標準ポートは省略する", "https://example.com:443/", "https://example.com"],
    ["非標準ポートは残す", "https://example.com:8443/", "https://example.com:8443"],
    ["公開IPリテラルは通す", "https://8.8.8.8/", "https://8.8.8.8"],
  ])("%s", (_label, input, expected) => {
    expect(normalizeWpSiteUrl(input)).toEqual({ ok: true, origin: expected });
  });

  // www の有無は別オリジンであり、勝手に落としてはいけない。落とすと
  // https://www.example.com からのアクセスが allowed_origins に一致せず、
  // ウィジェットが無言で止まる(I-1)。
  it("www は別オリジンとして保持する", () => {
    expect(normalizeWpSiteUrl("https://www.example.com")).toEqual({
      ok: true,
      origin: "https://www.example.com",
    });
  });

  it("国際化ドメインは punycode に変換される", () => {
    const result = normalizeWpSiteUrl("https://日本語.jp");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.origin).toBe("https://xn--wgv71a119e.jp");
  });
});

describe("normalizeWpSiteUrl — 異常系", () => {
  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
    ["スキーム無し", "example.com"],
    ["URL として壊れている", "https://"],
  ])("%s は invalid_url", (_label, input) => {
    expect(normalizeWpSiteUrl(input)).toEqual({ ok: false, reason: "invalid_url" });
  });

  // 文字列以外が来ても throw しない(WP からの入力は信用しない)。
  it.each([[null], [undefined], [123], [{}]])("非文字列 %p は invalid_url", (input) => {
    expect(normalizeWpSiteUrl(input as unknown as string)).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  // http と localhost は理由を分けて返す。1つの文言にまとめると
  // 「https にしてください」と「公開サイトが必要です」を出し分けられない(→ 禁止21)。
  it.each([
    ["http", "http://example.com"],
    ["ftp", "ftp://example.com"],
  ])("%s は not_https", (_label, input) => {
    expect(normalizeWpSiteUrl(input)).toEqual({ ok: false, reason: "not_https" });
  });

  it.each([
    ["localhost", "https://localhost"],
    ["localhost ポート付き", "https://localhost:8080"],
    ["*.localhost", "https://site.localhost"],
    [".local", "https://mysite.local"],
    [".test", "https://foo.test"],
    [".invalid", "https://foo.invalid"],
    [".example", "https://foo.example"],
    ["ループバックIPv4", "https://127.0.0.1"],
    ["0.0.0.0", "https://0.0.0.0"],
    ["プライベート 10/8", "https://10.0.0.1"],
    ["プライベート 192.168/16", "https://192.168.1.10"],
    ["プライベート 172.16/12 下端", "https://172.16.0.1"],
    ["プライベート 172.16/12 上端", "https://172.31.255.254"],
    ["リンクローカル", "https://169.254.1.1"],
    ["IPv6 ループバック", "https://[::1]"],
    ["単一ラベルのイントラネット名", "https://intranet"],
  ])("%s は not_public_host", (_label, input) => {
    expect(normalizeWpSiteUrl(input)).toEqual({ ok: false, reason: "not_public_host" });
  });
});

describe("isNonPublicHostname — プライベート範囲の境界", () => {
  // 172.16.0.0/12 の外側を誤って弾くと、正当な公開サイトが接続できなくなる。
  it.each([
    ["172.15.0.1", false],
    ["172.16.0.1", true],
    ["172.31.255.254", true],
    ["172.32.0.1", false],
    ["11.0.0.1", false],
    ["128.0.0.1", false],
    ["192.167.0.1", false],
    ["192.169.0.1", false],
  ])("%s → %s", (host, expected) => {
    expect(isNonPublicHostname(host)).toBe(expected);
  });

  it("大文字のホスト名でも判定できる", () => {
    expect(isNonPublicHostname("LOCALHOST")).toBe(true);
    expect(isNonPublicHostname("MySite.LOCAL")).toBe(true);
  });
});

describe("buildWpTenantId", () => {
  const ID_FORMAT = /^[a-z0-9_-]+$/;

  it("正常なホスト名からは wp-<ホスト>-<サフィックス> を組み立てる", () => {
    expect(buildWpTenantId("https://example.com", "abcd1234")).toBe("wp-example-abcd1234");
  });

  it("常に createTenantSchema の id 形式(3〜50字、[a-z0-9_-]+)に収まる", () => {
    const cases = [
      "https://a.com",
      "https://www.example.co.jp",
      "https://xn--wgv71a119e.jp",
      "https://8.8.8.8",
      "https://" + "a".repeat(200) + ".com",
      "not-a-valid-url",
      "",
    ];
    for (const origin of cases) {
      for (const suffix of ["", "x", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "!!!---???"]) {
        const id = buildWpTenantId(origin, suffix);
        expect(id.length).toBeGreaterThanOrEqual(3);
        expect(id.length).toBeLessThanOrEqual(50);
        expect(id).toMatch(ID_FORMAT);
      }
    }
  });

  it("URL として壊れている origin でも 'site' にフォールバックする(throwしない)", () => {
    expect(buildWpTenantId("not-a-url", "abcd")).toBe("wp-site-abcd");
  });

  it("記号だけのホスト名は 'site' にフォールバックする", () => {
    expect(buildWpTenantId("https://---.example.com", "abcd")).toBe("wp-site-abcd");
  });

  it("サフィックスが空文字でも '0' にフォールバックする(空IDを作らない)", () => {
    expect(buildWpTenantId("https://example.com", "")).toBe("wp-example-0");
  });

  it("サフィックスの大文字・記号は取り除いて小文字化する", () => {
    expect(buildWpTenantId("https://example.com", "AB-12_cd!!")).toBe("wp-example-ab12cd");
  });

  it("同じ入力からは常に同じIDを返す(決定的)", () => {
    const a = buildWpTenantId("https://example.com", "abcd1234");
    const b = buildWpTenantId("https://example.com", "abcd1234");
    expect(a).toBe(b);
  });

  it("非文字列のサフィックスでも throw しない", () => {
    expect(() => buildWpTenantId("https://example.com", undefined as unknown as string)).not.toThrow();
    expect(buildWpTenantId("https://example.com", undefined as unknown as string)).toBe("wp-example-0");
  });
});
