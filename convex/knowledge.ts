/**
 * convex/knowledge.ts
 *
 * 書籍 PDF の管理・AES-256-GCM 暗号化・RAG チャンク取得。
 *
 * セキュリティ原則（CLAUDE.md）:
 *  - 書籍テキストは AES-256-GCM で暗号化して保存し、平文はメモリ外に出さない
 *  - RAG 抜粋は必ず .slice(0, 200) で切る
 *  - console.log に書籍内容を出力しない
 *  - tenantId フィルタを全クエリに強制注入
 *  - 書籍内容を LLM のプロンプトに埋め込む場合は呼び出し元で slice(0,200) を適用すること
 *
 * NOTE: このモジュールは Node.js 組み込みの crypto モジュールのみを使用する。
 *       Convex SDK が利用可能な場合は ConvexHttpClient に置き換えること。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// 暗号化ユーティリティ
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12;  // 96 bit（GCM 推奨）
const AUTH_TAG_LENGTH = 16;

/**
 * 環境変数 KNOWLEDGE_ENCRYPTION_KEY から 32 バイトのキーを取得する。
 * 未設定の場合はエラー。
 */
function getEncryptionKey(): Buffer {
  const raw = process.env.KNOWLEDGE_ENCRYPTION_KEY;
  if (!raw) {
    throw new KnowledgeEncryptionError(
      "KNOWLEDGE_ENCRYPTION_KEY が未設定です。書籍データを操作できません。",
    );
  }

  // hex 64 文字（32 バイト）または base64 44 文字を受け付ける
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_LENGTH) {
    throw new KnowledgeEncryptionError(
      `KNOWLEDGE_ENCRYPTION_KEY は 32 バイト（hex 64 文字または base64 44 文字）である必要があります。`,
    );
  }
  return buf;
}

export interface EncryptedPayload {
  /** base64 encoded ciphertext */
  ciphertext: string;
  /** base64 encoded IV (12 bytes) */
  iv: string;
  /** base64 encoded auth tag (16 bytes) */
  authTag: string;
}

/**
 * テキストを AES-256-GCM で暗号化する。
 * 戻り値の ciphertext, iv, authTag はいずれも base64 文字列。
 */
export function encryptText(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * AES-256-GCM で暗号化されたテキストを復号する。
 * 認証に失敗した場合は KnowledgeEncryptionError をスローする。
 */
export function decryptText(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new KnowledgeEncryptionError(
      "書籍データの復号に失敗しました。鍵が不正またはデータが改ざんされています。",
    );
  }
}

// ---------------------------------------------------------------------------
// データモデル
// ---------------------------------------------------------------------------

export interface BookChunk {
  /** チャンク ID */
  id: string;
  /** テナント ID（JWT 由来） */
  tenantId: string;
  /** 書籍 ID */
  bookId: string;
  /** ページ番号（1 始まり） */
  page: number;
  /** チャンク番号（同一ページ内） */
  chunkIndex: number;
  /** 暗号化済みテキスト */
  encrypted: EncryptedPayload;
  /** Pinecone ベクター ID（検索用） */
  vectorId: string;
  /** 作成日時（Unix ms） */
  createdAt: number;
}

export interface BookMetadata {
  id: string;
  tenantId: string;
  title: string;
  author: string;
  totalPages: number;
  totalChunks: number;
  uploadedAt: number;
  /** 書籍テキスト自体はここには含めない */
}

// ---------------------------------------------------------------------------
// In-memory ストア（開発用 / Convex SDK 置き換え想定）
// ---------------------------------------------------------------------------

const chunkStore = new Map<string, BookChunk>();
const bookStore = new Map<string, BookMetadata>();

// ---------------------------------------------------------------------------
// 書籍チャンク操作
// ---------------------------------------------------------------------------

/**
 * 書籍チャンクを暗号化して保存する。
 *
 * @param params.tenantId - JWT 由来のテナント ID
 * @param params.plaintext - 平文テキスト（保存後は参照しないこと）
 */
export function storeBookChunk(params: {
  tenantId: string;
  bookId: string;
  page: number;
  chunkIndex: number;
  plaintext: string;
  vectorId: string;
}): BookChunk {
  const { tenantId, bookId, page, chunkIndex, plaintext, vectorId } = params;

  const id = `${tenantId}:${bookId}:${page}:${chunkIndex}`;
  const encrypted = encryptText(plaintext);

  const chunk: BookChunk = {
    id,
    tenantId,
    bookId,
    page,
    chunkIndex,
    encrypted,
    vectorId,
    createdAt: Date.now(),
  };

  chunkStore.set(id, chunk);
  return chunk;
}

/**
 * Pinecone ベクター ID からチャンクを取得し、RAG 抜粋（≤200 文字）を返す。
 *
 * tenantId フィルタを強制適用し、他テナントのデータは取得不可。
 *
 * @returns RAG 用抜粋（.slice(0, 200) 適用済み）
 */
export function getRagExcerpt(params: {
  vectorId: string;
  tenantId: string;
}): string | null {
  const { vectorId, tenantId } = params;

  const chunk = findChunkByVectorId(vectorId, tenantId);
  if (!chunk) return null;

  const plaintext = decryptText(chunk.encrypted);

  // セキュリティ制約: RAG 抜粋は必ず 200 文字以内で切る
  return plaintext.slice(0, 200);
}

/**
 * 書籍 ID からすべての RAG 抜粋を取得する（テナントフィルタ強制）。
 *
 * @returns RAG 用抜粋の配列（各要素 ≤200 文字）
 */
export function getBookRagExcerpts(params: {
  bookId: string;
  tenantId: string;
}): string[] {
  const { bookId, tenantId } = params;

  const chunks = Array.from(chunkStore.values()).filter(
    (c) => c.bookId === bookId && c.tenantId === tenantId,
  );

  // ページ・チャンク順にソート
  chunks.sort(
    (a, b) =>
      a.page - b.page || a.chunkIndex - b.chunkIndex,
  );

  return chunks.map((c) => {
    const plaintext = decryptText(c.encrypted);
    // セキュリティ制約: RAG 抜粋は必ず 200 文字以内で切る
    return plaintext.slice(0, 200);
  });
}

// ---------------------------------------------------------------------------
// 書籍メタデータ操作
// ---------------------------------------------------------------------------

export function registerBook(meta: BookMetadata): void {
  bookStore.set(meta.id, meta);
}

/**
 * テナント内の書籍一覧を取得する（テナントフィルタ強制）。
 * 書籍テキストは含まない。
 */
export function listBooks(tenantId: string): BookMetadata[] {
  return Array.from(bookStore.values()).filter(
    (b) => b.tenantId === tenantId,
  );
}

/**
 * 書籍メタデータを取得する（テナントフィルタ強制）。
 */
export function getBook(
  bookId: string,
  tenantId: string,
): BookMetadata | null {
  const meta = bookStore.get(bookId);
  if (!meta || meta.tenantId !== tenantId) return null;
  return meta;
}

/**
 * 書籍とそのすべてのチャンクを削除する（テナントフィルタ強制）。
 */
export function deleteBook(bookId: string, tenantId: string): boolean {
  const meta = bookStore.get(bookId);
  if (!meta || meta.tenantId !== tenantId) return false;

  bookStore.delete(bookId);

  for (const [key, chunk] of chunkStore.entries()) {
    if (chunk.bookId === bookId && chunk.tenantId === tenantId) {
      chunkStore.delete(key);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

function findChunkByVectorId(
  vectorId: string,
  tenantId: string,
): BookChunk | null {
  for (const chunk of chunkStore.values()) {
    if (chunk.vectorId === vectorId && chunk.tenantId === tenantId) {
      return chunk;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// エラークラス
// ---------------------------------------------------------------------------

export class KnowledgeEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeEncryptionError";
  }
}

export class KnowledgeTenantError extends Error {
  constructor(tenantId: string) {
    super(`テナント '${tenantId}' にアクセス権限がありません。`);
    this.name = "KnowledgeTenantError";
  }
}
