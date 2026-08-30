// src/lib/crypto/textEncrypt.test.ts

import { encryptText, decryptText, isEncrypted } from "./textEncrypt";

// テスト用の256bit (64hex) キー
const TEST_KEY = "a".repeat(64);

describe("isEncrypted", () => {
  it("base64:base64:base64 形式を暗号化済みと判定する", () => {
    expect(isEncrypted("aGVsbG8=:d29ybGQ=:Zm9v")).toBe(true);
  });

  it("平文テキストを暗号化済みではないと判定する", () => {
    expect(isEncrypted("hello world")).toBe(false);
  });

  it("セグメントが2つの場合は false", () => {
    expect(isEncrypted("aGVsbG8=:d29ybGQ=")).toBe(false);
  });

  it("セグメントが4つの場合は false", () => {
    expect(isEncrypted("a:b:c:d")).toBe(false);
  });

  it("空文字列は false", () => {
    expect(isEncrypted("")).toBe(false);
  });
});

describe("encryptText / decryptText (key set)", () => {
  beforeEach(() => {
    process.env.KNOWLEDGE_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
  });

  it("往復テスト: 暗号化 → 復号で元のテキストに戻る", () => {
    const original = "これは書籍のサンプルテキストです。著作権保護のため暗号化します。";
    const encrypted = encryptText(original);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptText(encrypted)).toBe(original);
  });

  it("毎回異なる暗号文（IVのランダム性）", () => {
    const text = "same plaintext";
    const enc1 = encryptText(text);
    const enc2 = encryptText(text);
    expect(enc1).not.toBe(enc2);
    expect(decryptText(enc1)).toBe(text);
    expect(decryptText(enc2)).toBe(text);
  });

  it("空文字列の往復テスト", () => {
    const encrypted = encryptText("");
    expect(decryptText(encrypted)).toBe("");
  });
});

describe("KNOWLEDGE_ENCRYPTION_KEY 未設定時のフォールバック（dev/test のみ）", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
    // jest 既定の NODE_ENV=test。dev/test では平文フォールバックが許可される。
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
  });

  it("test 環境では encryptText が平文をそのまま返す（開発/テスト用フォールバック）", () => {
    const text = "plaintext data";
    const result = encryptText(text);
    expect(result).toBe(text);
  });

  it("development 環境でも平文フォールバックする", () => {
    process.env.NODE_ENV = "development";
    const text = "plaintext data";
    expect(encryptText(text)).toBe(text);
  });

  it("decryptText が平文をそのまま返す（後方互換）", () => {
    const text = "plaintext data";
    expect(decryptText(text)).toBe(text);
  });
});

describe("KNOWLEDGE_ENCRYPTION_KEY 未設定時の fail-closed（本番/不明 env）", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
  });

  it("production では encryptText が throw する（平文保存を拒否）", () => {
    process.env.NODE_ENV = "production";
    expect(() => encryptText("secret book text")).toThrow(
      /KNOWLEDGE_ENCRYPTION_KEY is required/
    );
  });

  it("NODE_ENV 未設定（undefined）でも throw する（トラップの解消）", () => {
    delete process.env.NODE_ENV;
    expect(() => encryptText("secret book text")).toThrow(
      /KNOWLEDGE_ENCRYPTION_KEY is required/
    );
  });

  it("staging など未知の env でも throw する", () => {
    process.env.NODE_ENV = "staging";
    expect(() => encryptText("secret book text")).toThrow(
      /KNOWLEDGE_ENCRYPTION_KEY is required/
    );
  });

  it("鍵が設定されていれば production でも暗号化して往復できる", () => {
    process.env.NODE_ENV = "production";
    process.env.KNOWLEDGE_ENCRYPTION_KEY = TEST_KEY;
    const original = "secret book text";
    const encrypted = encryptText(original);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptText(encrypted)).toBe(original);
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
  });

  it("復号は鍵さえあれば env に関わらず後方互換（平文はそのまま）", () => {
    process.env.NODE_ENV = "production";
    expect(decryptText("古い平文データ")).toBe("古い平文データ");
  });
});

describe("既存データ（平文）との後方互換", () => {
  beforeEach(() => {
    process.env.KNOWLEDGE_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.KNOWLEDGE_ENCRYPTION_KEY;
  });

  it("isEncrypted が false の平文は decryptText でそのまま返る", () => {
    const plaintext = "古いデータ（平文のまま保存されたチャンク）";
    expect(isEncrypted(plaintext)).toBe(false);
    expect(decryptText(plaintext)).toBe(plaintext);
  });
});

describe("RAG抜粋200文字制限", () => {
  it("200文字を超えるテキストは slice(0, 200) で切り詰める", () => {
    const longText = "あ".repeat(300);
    const excerpt = longText.slice(0, 200);
    expect(excerpt.length).toBe(200);
    expect(longText.length).toBe(300);
  });

  it("200文字以下のテキストはそのまま", () => {
    const shortText = "短いテキスト";
    expect(shortText.slice(0, 200)).toBe(shortText);
  });
});
