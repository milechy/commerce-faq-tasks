// tests/api/i18n/messages.test.ts
// Phase33: メッセージ辞書 + t() 関数のテスト

import { t } from "../../../src/api/i18n/messages";

const ALL_KEYS = [
  "error.not_found",
  "error.unauthorized",
  "error.forbidden",
  "error.validation",
  "error.server",
  "success.created",
  "success.updated",
  "success.deleted",
];

describe("t() — message dictionary", () => {
  describe("ja messages", () => {
    test.each(ALL_KEYS)("key=%s returns a non-empty Japanese string", (key) => {
      const result = t(key, "ja");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      // Should not equal the key itself (i.e. the key was found in the dict)
      expect(result).not.toBe(key);
    });
  });

  describe("en messages", () => {
    test.each(ALL_KEYS)("key=%s returns a non-empty English string", (key) => {
      const result = t(key, "en");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toBe(key);
    });
  });

  test("ja and en messages differ for same key", () => {
    expect(t("error.server", "ja")).not.toBe(t("error.server", "en"));
  });

  test("unknown key returns the key itself", () => {
    expect(t("unknown.key.xyz", "ja")).toBe("unknown.key.xyz");
    expect(t("unknown.key.xyz", "en")).toBe("unknown.key.xyz");
  });

  test("error.validation ja contains expected text", () => {
    expect(t("error.validation", "ja")).toContain("入力");
  });

  test("error.validation en contains expected text", () => {
    expect(t("error.validation", "en")).toContain("input");
  });
});
