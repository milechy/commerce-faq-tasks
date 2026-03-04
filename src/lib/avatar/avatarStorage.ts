import * as crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STORAGE_ROOT = path.resolve(process.cwd(), "storage/avatars");
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface JwtTenantContext {
  tenantId: string;
}

export interface StoreAvatarImageInput {
  auth: JwtTenantContext;
  imageBuffer: Buffer;
  mimeType: string;
  originalFileName?: string;
}

export interface StoredAvatarImage {
  id: string;
  tenantId: string;
  storageKey: string;
  encryptedFilePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  encrypted: true;
  createdAt: string;
}

type EncryptedAvatarEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  tenantId: string;
  mimeType: string;
  originalFileName?: string;
  createdAt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  sha256: string;
};

function assertTenantId(tenantId: string): void {
  if (!tenantId || !/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error("無効なテナント情報です。");
  }
}

function readAvatarEncryptionKey(): Buffer {
  const raw = process.env.AVATAR_ENCRYPTION_KEY ?? "";
  if (!raw) {
    throw new Error("AVATAR_ENCRYPTION_KEY が設定されていません。");
  }

  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {
    // noop
  }

  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }

  throw new Error("AVATAR_ENCRYPTION_KEY は32バイト鍵で設定してください。");
}

function imageHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeStorageRoot(): string {
  const configured = process.env.AVATAR_STORAGE_ROOT?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : DEFAULT_STORAGE_ROOT;
}

function resolveSafeStoragePath(storageRoot: string, storageKey: string): string {
  const key = storageKey.replace(/\\/g, "/").trim();
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("../") ||
    key.includes("/..")
  ) {
    throw new Error("不正な保存先キーです。");
  }
  const resolved = path.resolve(storageRoot, key);
  const normalizedRoot = storageRoot.endsWith(path.sep)
    ? storageRoot
    : `${storageRoot}${path.sep}`;
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error("不正な保存先キーです。");
  }
  return resolved;
}

function maxImageBytes(): number {
  const parsed = Number(process.env.AVATAR_MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMAGE_BYTES;
}

const MAGIC_NUMBERS: Record<string, number[]> = {
  "image/png":  [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
  "image/gif":  [0x47, 0x49, 0x46, 0x38],
};

function validateImageInput(buffer: Buffer, mimeType: string): void {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error("画像形式に対応していません。PNG / JPEG / WebP / GIF を選択してください。");
  }
  if (buffer.byteLength === 0) {
    throw new Error("画像データが空です。");
  }
  if (buffer.byteLength > maxImageBytes()) {
    throw new Error("画像サイズが大きすぎます。");
  }

  const magic = MAGIC_NUMBERS[mimeType];
  if (!magic) {
    throw new Error("画像形式に対応していません。");
  }
  const matches = magic.every((byte, i) => buffer[i] === byte);
  if (!matches) {
    throw new Error("ファイルの内容が画像ではありません。別のファイルを選んでください。");
  }
}

export async function storeAvatarImageEncrypted(
  input: StoreAvatarImageInput
): Promise<StoredAvatarImage> {
  const { auth, imageBuffer, mimeType, originalFileName } = input;
  assertTenantId(auth.tenantId);
  validateImageInput(imageBuffer, mimeType);

  const key = readAvatarEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const aad = Buffer.from(`${auth.tenantId}:${mimeType}`, "utf8");
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(imageBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nowIso = new Date().toISOString();
  const id = crypto.randomUUID();
  const sha256 = imageHash(imageBuffer);

  const envelope: EncryptedAvatarEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    tenantId: auth.tenantId,
    mimeType,
    originalFileName,
    createdAt: nowIso,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    sha256,
  };

  const storageKey = `${auth.tenantId}/${id}.json`;
  const storageRoot = normalizeStorageRoot();
  const filePath = resolveSafeStoragePath(storageRoot, storageKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(envelope), { encoding: "utf8" });

  return {
    id,
    tenantId: auth.tenantId,
    storageKey,
    encryptedFilePath: filePath,
    mimeType,
    sizeBytes: imageBuffer.byteLength,
    sha256,
    encrypted: true,
    createdAt: nowIso,
  };
}

export async function decryptStoredAvatarImage(
  auth: JwtTenantContext,
  storageKey: string
): Promise<{ buffer: Buffer; mimeType: string; sha256: string }> {
  assertTenantId(auth.tenantId);
  if (!storageKey.startsWith(`${auth.tenantId}/`)) {
    throw new Error("この画像にアクセスする権限がありません。");
  }

  const storageRoot = normalizeStorageRoot();
  const filePath = resolveSafeStoragePath(storageRoot, storageKey);
  const raw = await readFile(filePath, "utf8");
  const envelope = JSON.parse(raw) as EncryptedAvatarEnvelope;

  if (envelope.algorithm !== "aes-256-gcm" || envelope.version !== 1) {
    throw new Error("サポートされていない暗号化形式です。");
  }
  if (envelope.tenantId !== auth.tenantId) {
    throw new Error("この画像にアクセスする権限がありません。");
  }

  const key = readAvatarEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  const aad = Buffer.from(`${auth.tenantId}:${envelope.mimeType}`, "utf8");
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  const digest = imageHash(decrypted);
  if (digest !== envelope.sha256) {
    throw new Error("画像データの整合性チェックに失敗しました。");
  }

  return {
    buffer: decrypted,
    mimeType: envelope.mimeType,
    sha256: envelope.sha256,
  };
}
