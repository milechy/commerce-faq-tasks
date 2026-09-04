// src/api/widget/wpSiteVerifier.ts
//
// サイト所有証明（要件書 §5.2 の一段目）。
// プラグインが自サイトに立てた REST ルートへ R2C 側から取りに行き、
// 発行済みチャレンジと一致するかを確かめる。これが無いと、第三者が
// 他人のドメインを申告して無制限にテナントを作れる（FR-04 / 受け入れ条件 C-1）。
//
// ★SSRF 対策を自前で書かない。
//   src/lib/net/ssrfGuard.ts の safeFetch が既に
//   「スキーム制限 / DNS 解決先IPの検査 / redirect:'manual' の毎ホップ再検査 /
//   タイムアウト / サイズ上限」を持つ。ここで fetch を直接呼ぶと、その全てを
//   失う。既知の残存リスク(DNS rebinding)も ssrfGuard 側に記録されている。
//
// 失敗理由を細かく分けているのは、利用者に「なぜ到達できないか」を具体的に
// 返すため（要件書 I-8: Basic認証やIP制限の下にあるサイト、I-9: ローカル環境）。
// 「検証に失敗しました」の一語にまとめると、メールが届かないのかサイトに
// 届かないのかを利用者が切り分けられない（→ 禁止21）。

import { safeFetch, SsrfBlockedError } from "../../lib/net/ssrfGuard";
import { WP_CHALLENGE_PREFIX } from "./wpProvisionToken";

/** プラグインが自サイトに立てる検証用ルート。プラグイン側と対で変更すること。 */
export const WP_VERIFY_PATH = "/wp-json/r2c/v1/verify";

/** 検証レスポンスの読み取り上限。チャレンジは 68 文字なので余裕を持って小さく取る。 */
export const WP_VERIFY_MAX_BYTES = 8 * 1024;

/** サイト取得のタイムアウト。接続操作の最中に同期で待つため短くする。 */
export const WP_VERIFY_TIMEOUT_MS = 5_000;

export type WpVerifyFailure =
  /** ネットワーク到達不能・タイムアウト・DNS 解決不能。 */
  | "unreachable"
  /** SSRF ガードが宛先を拒否した（内部IP等）。 */
  | "blocked"
  /** HTTP は返ったが 2xx ではない。Basic認証(401)・IP制限(403)・未設置(404) を含む。 */
  | "http_error"
  /** 本文が期待する形ではない（JSON でない・challenge が無い・型違い）。 */
  | "invalid_body"
  /** 形は正しいがチャレンジが一致しない。 */
  | "challenge_mismatch";

export type WpVerifyResult =
  | { ok: true }
  | { ok: false; reason: WpVerifyFailure; httpStatus?: number };

/** safeFetch を差し替えられるようにして、テストが実ネットワークに触れないようにする。 */
export interface WpSiteVerifierDeps {
  fetchImpl?: typeof safeFetch;
}

/**
 * 検証レスポンスの本文からチャレンジ値を取り出す純関数。
 *
 * 相手は「テナントのサイト」であって信用できる相手ではない。壊れた JSON・
 * 巨大な値・型違い・プレフィックス違いはすべて null に倒す。
 */
export function parseWpVerifyChallenge(body: string): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // 上限を超える本文はそもそも読まない（safeFetch 側でも制限しているが、
  // 差し替え可能な依存なのでここでも確かめる）。
  if (body.length > WP_VERIFY_MAX_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const value = (parsed as Record<string, unknown>).challenge;
  if (typeof value !== "string") return null;
  if (!value.startsWith(WP_CHALLENGE_PREFIX)) return null;
  // 生成されるチャレンジは prefix(4) + hex(64) の 68 文字固定。
  if (value.length !== WP_CHALLENGE_PREFIX.length + 64) return null;

  return value;
}

/**
 * origin のサイトへ検証ルートを取りに行き、期待するチャレンジと一致するか確かめる。
 *
 * origin は normalizeWpSiteUrl() を通した値を渡すこと。ここでは URL の妥当性を
 * 再判定せず、宛先の安全性は safeFetch(assertUrlAllowed) に委ねる。
 */
export async function verifyWpSiteChallenge(
  origin: string,
  expectedChallenge: string,
  deps: WpSiteVerifierDeps = {}
): Promise<WpVerifyResult> {
  const fetchImpl = deps.fetchImpl ?? safeFetch;
  const url = `${origin}${WP_VERIFY_PATH}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      timeoutMs: WP_VERIFY_TIMEOUT_MS,
      maxBytes: WP_VERIFY_MAX_BYTES,
      headers: { accept: "application/json" },
    });
  } catch (err) {
    // 宛先が拒否された場合と、単に届かない場合を分ける。前者は利用者の
    // 設定ミス（内部IPのサイトを申告した等）で、案内すべき内容が違う。
    if (err instanceof SsrfBlockedError) return { ok: false, reason: "blocked" };
    return { ok: false, reason: "unreachable" };
  }

  if (!res.ok) {
    // 401/403/404 をここで潰さない。Basic認証やIP制限が理由なら、利用者は
    // それを外せば解決できる（I-8）。
    return { ok: false, reason: "http_error", httpStatus: res.status };
  }

  let body: string;
  try {
    body = await res.text();
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const actual = parseWpVerifyChallenge(body);
  if (actual === null) return { ok: false, reason: "invalid_body" };
  if (actual !== expectedChallenge) return { ok: false, reason: "challenge_mismatch" };

  return { ok: true };
}
