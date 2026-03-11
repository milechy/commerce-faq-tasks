import crypto from "node:crypto";

const PREFIX = "rjc_";
const RANDOM_LENGTH = 32; // bytes → 64 hex chars

/**
 * `rjc_` + ランダム32バイト(hex64文字) のAPIキーを生成
 */
export function generateApiKey(): string {
  return PREFIX + crypto.randomBytes(RANDOM_LENGTH).toString("hex");
}

/**
 * APIキーをSHA-256ハッシュ化
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * マスク表示用: 最初の12文字 + "****"
 * 例: "rjc_abcdef123456****"
 */
export function maskApiKey(key: string): string {
  return key.slice(0, 12) + "****";
}

/**
 * prefixからマスク表示を生成（key_prefix列はキーの最初12文字を保存）
 */
export function maskApiKeyPrefix(prefix: string): string {
  return prefix + "****";
}
