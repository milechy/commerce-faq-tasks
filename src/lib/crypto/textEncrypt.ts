// src/lib/crypto/textEncrypt.ts

// 書籍著作権保護: faq_embeddings.text の AES-256-GCM 暗号化ユーティリティ
//
// 環境変数:
//   KNOWLEDGE_ENCRYPTION_KEY — 64文字hex (= 256bit)
//
// [P1 fail-closed] 未設定時の扱い（保存経路）:
//   - production / staging / 不明 env → throw（平文での永続化を禁止）。
//   - development / test → warn を出して平文フォールバック（ローカル開発・
//     テストを壊さないための明示的なエスケープ）。
//   これにより「KNOWLEDGE_ENCRYPTION_KEY 未設定のまま本番が知識/書籍を平文保存する」
//   fail-open（従来は全環境で warn のみ）を塞ぐ。NODE_ENV 未設定=非production 扱いで
//   平文保存されるトラップも、undefined を fail-closed 側に倒すことで解消する。
//   起動時にも authSecretsGuard（src/lib/startup/authSecretsGuard.ts）が同じ env を
//   検査し、production/不明 env では鍵欠落でそもそもブートさせない。
//
// 生成方法:
//   python3 -c "import secrets; print(secrets.token_hex(32))"

import crypto from "crypto";
import { logger } from '../logger';

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

// 平文フォールバックを許す「安全な非本番」env。internalSecretGuard.ts と同じ方針。
const SAFE_PLAINTEXT_FALLBACK_ENVS = new Set(["development", "test"]);

/**
 * 鍵欠落時に平文フォールバック（暗号化せず平文保存）を許可してよい実行環境か。
 * development / test のみ true（jest は NODE_ENV=test を既定でセットする）。
 * それ以外（production / staging / NODE_ENV 未設定など）では false = fail-closed。
 */
function plaintextFallbackAllowed(): boolean {
  const nodeEnv = process.env.NODE_ENV ?? "";
  return SAFE_PLAINTEXT_FALLBACK_ENVS.has(nodeEnv);
}

function getEncryptionKey(): Buffer | null {
  const hexKey = process.env.KNOWLEDGE_ENCRYPTION_KEY;
  if (!hexKey) {
    return null;
  }
  if (hexKey.length !== 64) {
    throw new Error(
      "KNOWLEDGE_ENCRYPTION_KEY must be 64 hex characters (256 bits)"
    );
  }
  return Buffer.from(hexKey, "hex");
}

/**
 * テキストを AES-256-GCM で暗号化する。
 *
 * KNOWLEDGE_ENCRYPTION_KEY 未設定時:
 *   - development / test（または jest）→ warn を出して平文をそのまま返す（後方互換）。
 *   - それ以外（production / 不明 env）→ throw（平文での永続化を禁止＝fail-closed）。
 *
 * 出力フォーマット: `<iv_base64>:<authTag_base64>:<encrypted_base64>`
 */
export function encryptText(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) {
    if (!plaintextFallbackAllowed()) {
      // fail-closed: 本番/不明 env で鍵が無いなら平文保存を拒否する。
      throw new Error(
        "[textEncrypt] KNOWLEDGE_ENCRYPTION_KEY is required to store knowledge text. " +
          "Refusing to persist plaintext (fail-closed). " +
          "Set KNOWLEDGE_ENCRYPTION_KEY (64 hex characters), " +
          "or run with NODE_ENV=development|test for local/testing."
      );
    }
    logger.warn(
      "[textEncrypt] KNOWLEDGE_ENCRYPTION_KEY is not set. Storing plaintext " +
        "(dev/test fallback). Set this variable to enable encryption."
    );
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * 暗号化済みテキストを復号する。
 * isEncrypted() が false の場合（平文）はそのまま返す（後方互換）。
 * KNOWLEDGE_ENCRYPTION_KEY 未設定かつ暗号化済みデータの場合はエラー。
 */
export function decryptText(ciphertext: string): string {
  if (!isEncrypted(ciphertext)) {
    return ciphertext;
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      "KNOWLEDGE_ENCRYPTION_KEY is required to decrypt encrypted text"
    );
  }

  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }

  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

/**
 * テキストが暗号化済み（`<base64>:<base64>:<base64>` 形式）かどうかを判定する。
 * 後方互換のため、平文データが混在していても安全に扱える。
 */
export function isEncrypted(text: string): boolean {
  // 3つのbase64セグメントが ':' で区切られているか確認
  // iv と authTag は必須（長さ > 0）、encryptedPayload は空文字列を許容（空平文の暗号化）
  const parts = text.split(":");
  if (parts.length !== 3) return false;
  const base64Re = /^[A-Za-z0-9+/]+=*$/;
  const [iv, authTag, encPayload] = parts;
  if (!iv || !base64Re.test(iv)) return false;
  if (!authTag || !base64Re.test(authTag)) return false;
  // encPayload は空（平文が空文字列の場合）またはbase64
  if (encPayload.length > 0 && !base64Re.test(encPayload)) return false;
  return true;
}
