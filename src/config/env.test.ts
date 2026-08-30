// src/config/env.test.ts
// B3: production 環境での SUPABASE_JWT_SECRET / WIDGET_JWT_SECRET 必須化の回帰テスト。
// envSchema を直接 safeParse することで、モジュールロード時に一度だけ実行される
// validateEnv() の副作用（process.exit）を経由せずロジックを検証する。

import { _envSchemaForTest as envSchema } from "./env";

const REQUIRED_BASE = {
  DATABASE_URL: "postgres://localhost/test",
  ES_URL: "http://localhost:9200",
  AGENT_API_KEY: "test-agent-key",
  GROQ_API_KEY: "test-groq-key",
};

function parse(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = { ...REQUIRED_BASE };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return envSchema.safeParse(env);
}

function issuePaths(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join("."));
}

describe("env.ts — production secret required (B3)", () => {
  describe("正常系", () => {
    it("production で必須 secret 設定済み → 成功", () => {
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "s".repeat(32),
        WIDGET_JWT_SECRET: "w".repeat(32),
        KNOWLEDGE_ENCRYPTION_KEY: "a".repeat(64),
      });
      expect(result.success).toBe(true);
    });

    it("development では両方未設定でも成功（必須化されない）", () => {
      const result = parse({ NODE_ENV: "development" });
      expect(result.success).toBe(true);
    });

    it("test では両方未設定でも成功（必須化されない）", () => {
      const result = parse({ NODE_ENV: "test" });
      expect(result.success).toBe(true);
    });
  });

  describe("境界値・異常系", () => {
    it("production で全未設定 → 3つの path でエラー", () => {
      const result = parse({ NODE_ENV: "production" });
      expect(result.success).toBe(false);
      const paths = issuePaths(result);
      expect(paths).toContain("SUPABASE_JWT_SECRET");
      expect(paths).toContain("WIDGET_JWT_SECRET");
      expect(paths).toContain("KNOWLEDGE_ENCRYPTION_KEY");
    });

    it("[P1] production で KNOWLEDGE_ENCRYPTION_KEY のみ欠落 → KNOWLEDGE_ENCRYPTION_KEY のエラー", () => {
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "s".repeat(32),
        WIDGET_JWT_SECRET: "w".repeat(32),
        KNOWLEDGE_ENCRYPTION_KEY: undefined,
      });
      expect(result.success).toBe(false);
      const paths = issuePaths(result);
      expect(paths).toContain("KNOWLEDGE_ENCRYPTION_KEY");
      expect(paths).not.toContain("SUPABASE_JWT_SECRET");
      expect(paths).not.toContain("WIDGET_JWT_SECRET");
    });

    it("[P1] development では KNOWLEDGE_ENCRYPTION_KEY 未設定でも成功（必須化されない）", () => {
      const result = parse({ NODE_ENV: "development" });
      expect(result.success).toBe(true);
    });

    it("production で SUPABASE_JWT_SECRET が空文字列 '' → エラー（未設定と同様に扱う）", () => {
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "",
        WIDGET_JWT_SECRET: "w".repeat(32),
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("SUPABASE_JWT_SECRET");
    });

    it("production で SUPABASE_JWT_SECRET が空白のみ '   ' → エラー（trim後に空とみなす）", () => {
      // 素の `!value` チェックだと空白のみの文字列は truthy のため通ってしまう罠がある。
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "   ",
        WIDGET_JWT_SECRET: "w".repeat(32),
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("SUPABASE_JWT_SECRET");
    });

    it("production で WIDGET_JWT_SECRET が空白のみ → エラー", () => {
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "s".repeat(32),
        WIDGET_JWT_SECRET: "\t\n  ",
      });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("WIDGET_JWT_SECRET");
    });

    it("production で WIDGET_JWT_SECRET のみ欠落（SUPABASE_JWT_SECRET はある） → WIDGET_JWT_SECRET のみエラー", () => {
      const result = parse({
        NODE_ENV: "production",
        SUPABASE_JWT_SECRET: "s".repeat(32),
      });
      expect(result.success).toBe(false);
      const paths = issuePaths(result);
      expect(paths).toContain("WIDGET_JWT_SECRET");
      expect(paths).not.toContain("SUPABASE_JWT_SECRET");
    });

    it("production で SUPABASE_JWT_SECRET のみ欠落（WIDGET_JWT_SECRET はある） → SUPABASE_JWT_SECRET のみエラー", () => {
      const result = parse({
        NODE_ENV: "production",
        WIDGET_JWT_SECRET: "w".repeat(32),
      });
      expect(result.success).toBe(false);
      const paths = issuePaths(result);
      expect(paths).toContain("SUPABASE_JWT_SECRET");
      expect(paths).not.toContain("WIDGET_JWT_SECRET");
    });
  });

  describe("イレギュラー操作", () => {
    it("development で secret 未設定→productionへ切替えた入力を再parseすると必須化される（起動時チェックが動的env変更にも追随する設計であること）", () => {
      const devResult = parse({ NODE_ENV: "development" });
      expect(devResult.success).toBe(true);

      const prodResult = parse({ NODE_ENV: "production" });
      expect(prodResult.success).toBe(false);
    });

    it("NODE_ENV 未指定は development 扱いになり必須化されない（既定値の罠）", () => {
      const result = parse({ NODE_ENV: undefined });
      expect(result.success).toBe(true);
    });
  });
});
