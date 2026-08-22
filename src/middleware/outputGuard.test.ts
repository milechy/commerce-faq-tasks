// src/middleware/outputGuard.test.ts
// L8 Output Guard: production 既定ON / development・test 既定OFF の確認

import { guardOutput } from "./outputGuard";

describe("guardOutput: enabled-flag default", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("production かつフラグ未設定なら既定ONでPII(メールアドレス)を redact する", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OUTPUT_GUARD_ENABLED;

    const result = guardOutput("ご連絡先は taro@example.com までお願いします");
    expect(result.safe).toBe(false);
    expect(result.redactions).toContain("email");
    expect(result.sanitizedResponse).not.toContain("taro@example.com");
  });

  it("production かつ OUTPUT_GUARD_ENABLED=false なら明示的にOFFにできる", () => {
    process.env.NODE_ENV = "production";
    process.env.OUTPUT_GUARD_ENABLED = "false";

    const result = guardOutput("ご連絡先は taro@example.com までお願いします");
    expect(result.safe).toBe(true);
    expect(result.sanitizedResponse).toContain("taro@example.com");
  });

  it("development かつフラグ未設定なら既定OFF（従来動作を維持）", () => {
    process.env.NODE_ENV = "development";
    delete process.env.OUTPUT_GUARD_ENABLED;

    const result = guardOutput("ご連絡先は taro@example.com までお願いします");
    expect(result.safe).toBe(true);
  });
});

describe("guardOutput: 複数redaction・境界値", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.OUTPUT_GUARD_ENABLED;
  });

  it("電話番号・メール・郵便番号が1つの応答に混在しても全て redact される", () => {
    const result = guardOutput(
      "お問い合わせは 03-1234-5678 または taro@example.com まで。所在地は 100-0001 です。",
    );
    expect(result.safe).toBe(false);
    expect(result.redactions).toEqual(
      expect.arrayContaining(["phone_hyphen", "email", "postal_code"]),
    );
    expect(result.sanitizedResponse).not.toContain("taro@example.com");
    expect(result.sanitizedResponse).not.toContain("03-1234-5678");
  });

  it("ハイフンなし携帯電話番号（0始まり10-11桁）もredactされる", () => {
    const result = guardOutput("担当直通は09012345678です");
    expect(result.redactions).toContain("phone_plain");
    expect(result.sanitizedResponse).not.toContain("09012345678");
  });

  it("システムプロンプト由来の既定スニペットが応答に混入していたらredactされる", () => {
    const result = guardOutput("弊社の方針として Security First を掲げています");
    expect(result.redactions).toContain("system_prompt_leak");
    expect(result.sanitizedResponse).not.toContain("Security First");
  });

  it("呼び出し元が渡す追加スニペット（テナント固有のシステムプロンプト断片）もredactされる", () => {
    const result = guardOutput(
      "当店の内部指示は「絶対に返金しない」です",
      ["絶対に返金しない"],
    );
    expect(result.redactions).toContain("system_prompt_leak");
    expect(result.sanitizedResponse).not.toContain("絶対に返金しない");
  });

  it("RAG抜粋は200字ちょうどなら切り詰められない", () => {
    const block = "あ".repeat(200);
    const result = guardOutput(block);
    expect(result.redactions).not.toContain("rag_excerpt_exceeded");
    expect(result.sanitizedResponse).toBe(block);
  });

  it("RAG抜粋が201字（1ブロック内、句読点/改行なし）だと200字+...に切り詰められる", () => {
    const block = "あ".repeat(201);
    const result = guardOutput(block);
    expect(result.redactions).toContain("rag_excerpt_exceeded");
    expect(result.sanitizedResponse).toBe("あ".repeat(200) + "...");
  });

  it("句読点で区切られた複数ブロックは、各ブロックが独立して200字判定される（合計ではない）", () => {
    // 各文が200字以下なら、応答全体が200字を超えても切り詰められない。
    const sentence1 = "あ".repeat(150) + "。";
    const sentence2 = "い".repeat(150) + "。";
    const result = guardOutput(sentence1 + sentence2);
    expect(result.redactions).not.toContain("rag_excerpt_exceeded");
  });

  it("MAX_RAG_EXCERPT_LENGTHに数値以外を設定すると既定値200にフォールバックする", () => {
    process.env.MAX_RAG_EXCERPT_LENGTH = "invalid";
    const block = "あ".repeat(201);
    const result = guardOutput(block);
    expect(result.redactions).toContain("rag_excerpt_exceeded");
    expect(result.sanitizedResponse).toBe("あ".repeat(200) + "...");
  });

  it("何もredactすべき内容がない通常応答はsafe=trueで原文のまま返る（過剰redactしない）", () => {
    const result = guardOutput("保証期間は購入日から2年間です。");
    expect(result.safe).toBe(true);
    expect(result.redactions).toHaveLength(0);
    expect(result.sanitizedResponse).toBe("保証期間は購入日から2年間です。");
  });
});
