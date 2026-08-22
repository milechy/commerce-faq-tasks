// src/middleware/inputSanitizer.test.ts
// L5 Input Sanitizer: production 既定ON / development・test 既定OFF の確認

import { sanitizeInput } from "./inputSanitizer";

describe("sanitizeInput: enabled-flag default", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("production かつフラグ未設定なら既定ONでURLをブロックする", () => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-prod-default");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("url_detected");
  });

  it("production かつ INPUT_SANITIZER_ENABLED=false なら明示的にOFFにできる", () => {
    process.env.NODE_ENV = "production";
    process.env.INPUT_SANITIZER_ENABLED = "false";

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-prod-off");
    expect(result.allowed).toBe(true);
  });

  it("development かつフラグ未設定なら既定OFF（従来動作を維持）", () => {
    process.env.NODE_ENV = "development";
    delete process.env.INPUT_SANITIZER_ENABLED;

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-dev-default");
    expect(result.allowed).toBe(true);
  });

  it("development かつ INPUT_SANITIZER_ENABLED=true なら明示的にONにできる", () => {
    process.env.NODE_ENV = "development";
    process.env.INPUT_SANITIZER_ENABLED = "true";

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-dev-on");
    expect(result.allowed).toBe(false);
  });
});
