// src/lib/crypto/textEncrypt.ts

// 書籍著作権保護: faq_embeddings.text の AES-256-GCM 暗号化ユーティリティ
//
// 環境変数:
//   KNOWLEDGE_ENCRYPTION_KEY — 64文字hex (= 256bit)
//   未設定の場合は平文保存のままフォールバック（console.warn を出力）
//
// 生成方法:
//   python3 -c "import secrets; print(secrets.token_hex(32))"

import crypto from "crypto";
import { logger } from '../logger';

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

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
 * KNOWLEDGE_ENCRYPTION_KEY 未設定の場合は平文をそのまま返す。
 *
 * 出力フォーマット: `<iv_base64>:<authTag_base64>:<encrypted_base64>`
 */
export function encryptText(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) {
    logger.warn(
      "[textEncrypt] KNOWLEDGE_ENCRYPTION_KEY is not set. Storing plaintext. " +
        "Set this variable to enable encryption."
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
