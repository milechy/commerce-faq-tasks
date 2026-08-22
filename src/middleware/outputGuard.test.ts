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
