// src/api/widget/wpProvisionToken.ts
//
// WordPress プラグインのプロビジョニングで使う 2 種類のワンタイム秘密値と、
// その有効期限判定。DB も HTTP も要らない純関数のみを置く。
//
// ★JWT を使わない理由
//   当初は WIDGET_JWT_SECRET で署名した JWT を想定していたが、既存の作法に
//   合わせる方が正しいと判断した。
//   (1) プロビジョニングはサーバ側に状態(wp_provisionings 行)を持つため、
//       JWT の利点であるステートレス性が不要。
//   (2) tenant_api_keys が既に「ランダム値を発行し、SHA-256 ハッシュだけを
//       DB に保存する」形を採っており(apiKeyUtils.ts)、同じ漏洩耐性が得られる。
//   (3) 署名鍵を持たないので、禁止27(公開配布物と管理APIで同じ署名鍵を使う)を
//       そもそも踏みようがない。JWT を選ぶと発行のたびに鍵の使い分けを
//       判断し続けることになる。
//
//   ハッシュ方式は apiKeyUtils.hashApiKey に委譲する。ここで sha256 を
//   書き直すと、方式が割れたときに照合できなくなる。

import crypto from "node:crypto";
import { hashApiKey } from "../admin/tenants/apiKeyUtils";

/** R2C がテナントのサイトへ取りに行き、一致を確認する値。 */
export const WP_CHALLENGE_PREFIX = "wpc_";
/** プラグインが発行状態のポーリングに使う値。 */
export const WP_POLL_TOKEN_PREFIX = "wpp_";

const RANDOM_LENGTH = 32; // bytes → 64 hex chars（apiKeyUtils と同じ強度）

/**
 * チャレンジの有効期限。接続ボタンを押した直後に R2C がサイトを取得しに行くため
 * 短くてよい。長くすると、サイト側に置かれたままの値で後から検証を通せる窓が広がる。
 */
export const WP_CHALLENGE_TTL_MINUTES = 15;

/**
 * プロビジョニング全体の有効期限。メール確認のリンククリックを待つので長い。
 * 期限切れは「トークンが存在しない」と区別して返すこと(→ 禁止20)。区別しないと
 * 再送導線を出せない(要件書 X-2 / I-7)。
 */
export const WP_PROVISION_TTL_HOURS = 24;

function generateSecret(prefix: string): string {
  return prefix + crypto.randomBytes(RANDOM_LENGTH).toString("hex");
}

/** サイト所有証明のチャレンジ値を生成する。 */
export function generateWpChallenge(): string {
  return generateSecret(WP_CHALLENGE_PREFIX);
}

/** ポーリング用トークンを生成する。 */
export function generateWpPollToken(): string {
  return generateSecret(WP_POLL_TOKEN_PREFIX);
}

/**
 * DB に保存するハッシュ。平文は発行時に一度返すだけで保存しない
 * (tenant_api_keys.key_hash と同じ扱い)。
 */
export function hashWpSecret(secret: string): string {
  return hashApiKey(secret);
}

/**
 * ログ・画面表示用のマスク。プロビジョニングの秘密値は tenant_api_keys と違い
 * key_prefix 列を持たせないため、原文からその場で作る。
 */
export function maskWpSecret(secret: string): string {
  return secret.slice(0, 12) + "****";
}

/**
 * 受け取った値が、その用途のプレフィックスを持つか。
 * チャレンジ値をポーリングトークンとして使い回す経路を塞ぐ
 * (ハッシュが同じ列に入る設計にしないための最初の関門)。
 */
export function hasWpSecretPrefix(secret: string, prefix: string): boolean {
  return typeof secret === "string" && secret.startsWith(prefix);
}

/**
 * 期限切れ判定。`issuedAt` から `ttlMinutes` 経過していれば true。
 *
 * 引数で now を受けるのは、テストが実時間に依存しないため。UTC のミリ秒差分
 * のみで判定し、process TZ に依存しない(→ 禁止16 / weekRange.ts と同じ作法)。
 * 不正な日付は「期限切れ」に倒す(fail-closed)。
 */
export function isWpSecretExpired(issuedAt: Date, now: Date, ttlMinutes: number): boolean {
  const issued = issuedAt instanceof Date ? issuedAt.getTime() : Number.NaN;
  const current = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(issued) || !Number.isFinite(current)) return true;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 0) return true;
  return current - issued >= ttlMinutes * 60_000;
}
