// src/api/widget/wpSiteVerifier.test.ts
//
// 要件書 docs/WORDPRESS_PLUGIN_REQUIREMENTS.md の以下を固定する:
//   FR-04 / C-1  サイト所有証明が通らない限り ok を返さない
//   I-8          Basic認証・IP制限の下にあるサイト（理由を潰さない）
//   I-9          ローカル環境・内部IP（SSRFガードが拒否）
//   X-1          検証ルートが応答しない

import { SsrfBlockedError } from "../../lib/net/ssrfGuard";
import {
  WP_VERIFY_PATH,
  WP_VERIFY_MAX_BYTES,
  parseWpVerifyChallenge,
  verifyWpSiteChallenge,
} from "./wpSiteVerifier";

const CHALLENGE = "wpc_" + "a".repeat(64);

/** 最小の Response 風オブジェクト（safeFetch の戻りとして使う分だけ）。 */
function fakeResponse(opts: { ok?: boolean; status?: number; body?: string; textThrows?: boolean }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: opts.textThrows
      ? () => Promise.reject(new Error("stream error"))
      : () => Promise.resolve(opts.body ?? ""),
  } as unknown as Response;
}

describe("parseWpVerifyChallenge", () => {
  it("正しい形の JSON からチャレンジを取り出す", () => {
    expect(parseWpVerifyChallenge(JSON.stringify({ challenge: CHALLENGE }))).toBe(CHALLENGE);
  });

  it("余分なキーがあっても取り出せる", () => {
    expect(
      parseWpVerifyChallenge(JSON.stringify({ challenge: CHALLENGE, plugin: "1.0.0" }))
    ).toBe(CHALLENGE);
  });

  // 相手はテナントのサイトであって信用できる相手ではない。壊れた入力で
  // 例外を投げると、検証の失敗ではなく 500 になる。
  it.each([
    ["空文字", ""],
    ["JSON でない", "<html>not json</html>"],
    ["配列", "[]"],
    ["null", "null"],
    ["数値", "42"],
    ["challenge が無い", JSON.stringify({ ok: true })],
    ["challenge が文字列でない", JSON.stringify({ challenge: 123 })],
    ["challenge が null", JSON.stringify({ challenge: null })],
    ["challenge がオブジェクト", JSON.stringify({ challenge: { a: 1 } })],
    ["プレフィックスが違う", JSON.stringify({ challenge: "wpp_" + "a".repeat(64) })],
    ["短すぎる", JSON.stringify({ challenge: "wpc_abc" })],
    ["長すぎる", JSON.stringify({ challenge: "wpc_" + "a".repeat(65) })],
  ])("%s は null", (_label, body) => {
    expect(parseWpVerifyChallenge(body)).toBeNull();
  });

  it("非文字列でも throw しない", () => {
    expect(parseWpVerifyChallenge(null as unknown as string)).toBeNull();
    expect(parseWpVerifyChallenge(undefined as unknown as string)).toBeNull();
  });

  it("上限を超える本文は読まずに null", () => {
    const huge = JSON.stringify({ challenge: CHALLENGE, pad: "x".repeat(WP_VERIFY_MAX_BYTES) });
    expect(parseWpVerifyChallenge(huge)).toBeNull();
  });
});

describe("verifyWpSiteChallenge", () => {
  it("チャレンジが一致すれば ok", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fakeResponse({ body: JSON.stringify({ challenge: CHALLENGE }) })
    );
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: true });
  });

  it("プラグインの検証ルートを origin に連結して取りに行く", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fakeResponse({ body: JSON.stringify({ challenge: CHALLENGE }) })
    );
    await verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://example.com${WP_VERIFY_PATH}`);
    // タイムアウトとサイズ上限を必ず渡す（既定の10秒/5MiBのままにしない）
    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.timeoutMs).toBeLessThanOrEqual(5000);
    expect(opts.maxBytes).toBeLessThanOrEqual(8 * 1024);
  });

  // ★別サイトのチャレンジを置かれても通らないこと。これが C-1 の本体。
  it("チャレンジが違えば challenge_mismatch", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fakeResponse({ body: JSON.stringify({ challenge: "wpc_" + "b".repeat(64) }) })
    );
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "challenge_mismatch" });
  });

  // I-8: 理由を潰さない。401/403/404 を「失敗」の一語にまとめない。
  it.each([
    ["Basic認証", 401],
    ["IP制限", 403],
    ["プラグイン未設置", 404],
    ["サーバエラー", 500],
    ["メンテナンス", 503],
  ])("%s(%i) は http_error とステータスを返す", async (_label, status) => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse({ ok: false, status }));
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "http_error", httpStatus: status });
  });

  // I-9: 内部IP等は SSRF ガードが拒否する。到達不能と区別する
  // （利用者に返す案内が違う: 前者は申告ミス、後者はネットワーク側）。
  it("SSRF ガードに拒否されたら blocked", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new SsrfBlockedError("private ip"));
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "blocked" });
  });

  it("到達不能・タイムアウトは unreachable", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("本文の読み取りに失敗しても throw せず unreachable", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse({ textThrows: true }));
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it.each([
    ["HTML が返る", "<html></html>"],
    ["空", ""],
    ["challenge が無い", JSON.stringify({ ok: true })],
  ])("%s は invalid_body", async (_label, body) => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse({ body }));
    await expect(
      verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
    ).resolves.toEqual({ ok: false, reason: "invalid_body" });
  });

  it("どの失敗経路でも例外を投げない", async () => {
    const cases = [
      jest.fn().mockRejectedValue(new SsrfBlockedError("x")),
      jest.fn().mockRejectedValue(new Error("x")),
      jest.fn().mockResolvedValue(fakeResponse({ ok: false, status: 500 })),
      jest.fn().mockResolvedValue(fakeResponse({ body: "{" })),
    ];
    for (const fetchImpl of cases) {
      await expect(
        verifyWpSiteChallenge("https://example.com", CHALLENGE, { fetchImpl })
      ).resolves.toHaveProperty("ok", false);
    }
  });
});
