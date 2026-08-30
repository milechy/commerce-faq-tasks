// src/lib/startup/authSecretsGuard.test.ts
// [P1] 認証/署名/暗号 secret の起動時 invariant のテスト。
// evaluateAuthSecretsGuard は純関数なので env を注入して検証する。

import {
  evaluateAuthSecretsGuard,
  assertAuthSecretsConfigured,
} from "./authSecretsGuard";

const ALL_SECRETS = {
  SUPABASE_JWT_SECRET: "s".repeat(32),
  WIDGET_JWT_SECRET: "w".repeat(32),
  KNOWLEDGE_ENCRYPTION_KEY: "a".repeat(64),
};

describe("evaluateAuthSecretsGuard", () => {
  it("全 secret 設定済み → ok / mustExit=false（env に依らず）", () => {
    for (const NODE_ENV of ["production", "development", "test", "staging", ""]) {
      const r = evaluateAuthSecretsGuard({ ...ALL_SECRETS, NODE_ENV } as NodeJS.ProcessEnv);
      expect(r.result).toBe("ok");
      expect(r.mustExit).toBe(false);
      expect(r.missing).toEqual([]);
    }
  });

  it("development で欠落 → warn / mustExit=false", () => {
    const r = evaluateAuthSecretsGuard({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(r.result).toBe("warn");
    expect(r.mustExit).toBe(false);
    expect(r.missing).toEqual([
      "SUPABASE_JWT_SECRET",
      "WIDGET_JWT_SECRET",
      "KNOWLEDGE_ENCRYPTION_KEY",
    ]);
  });

  it("test で欠落 → warn / mustExit=false", () => {
    const r = evaluateAuthSecretsGuard({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(r.mustExit).toBe(false);
  });

  it("[P1] production で欠落 → mustExit=true", () => {
    const r = evaluateAuthSecretsGuard({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(r.mustExit).toBe(true);
    expect(r.reason).toContain("non-safe-env-production");
  });

  it("[P1] NODE_ENV 未設定（undefined）で欠落 → mustExit=true（トラップ解消）", () => {
    const r = evaluateAuthSecretsGuard({} as NodeJS.ProcessEnv);
    expect(r.mustExit).toBe(true);
    expect(r.reason).toContain("undefined");
  });

  it("[P1] staging など未知 env で欠落 → mustExit=true", () => {
    const r = evaluateAuthSecretsGuard({ NODE_ENV: "staging" } as NodeJS.ProcessEnv);
    expect(r.mustExit).toBe(true);
  });

  it("[P1] 空白のみの値は未設定扱い（production で mustExit=true）", () => {
    const r = evaluateAuthSecretsGuard({
      NODE_ENV: "production",
      SUPABASE_JWT_SECRET: "   ",
      WIDGET_JWT_SECRET: "\t\n",
      KNOWLEDGE_ENCRYPTION_KEY: " ",
    } as NodeJS.ProcessEnv);
    expect(r.mustExit).toBe(true);
    expect(r.missing).toContain("SUPABASE_JWT_SECRET");
  });

  it("一部だけ欠落 → missing にその名前だけが並ぶ", () => {
    const r = evaluateAuthSecretsGuard({
      NODE_ENV: "production",
      SUPABASE_JWT_SECRET: "s".repeat(32),
      WIDGET_JWT_SECRET: "w".repeat(32),
    } as NodeJS.ProcessEnv);
    expect(r.missing).toEqual(["KNOWLEDGE_ENCRYPTION_KEY"]);
    expect(r.mustExit).toBe(true);
  });
});

describe("assertAuthSecretsConfigured", () => {
  function makeLogger() {
    return { warn: jest.fn(), fatal: jest.fn() };
  }

  it("production 欠落 → fatal ログ + onFatal 呼び出し", () => {
    const logger = makeLogger();
    const onFatal = jest.fn(() => {
      throw new Error("__exit__");
    });
    expect(() =>
      assertAuthSecretsConfigured(logger, { NODE_ENV: "production" } as NodeJS.ProcessEnv, onFatal as never),
    ).toThrow("__exit__");
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
  });

  it("test 欠落 → warn のみ、onFatal は呼ばれない", () => {
    const logger = makeLogger();
    const onFatal = jest.fn(() => {
      throw new Error("__exit__");
    });
    const result = assertAuthSecretsConfigured(
      logger,
      { NODE_ENV: "test" } as NodeJS.ProcessEnv,
      onFatal as never,
    );
    expect(result).toBe("warn");
    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("全 secret 設定済み → ok、ログ無し", () => {
    const logger = makeLogger();
    const result = assertAuthSecretsConfigured(logger, {
      ...ALL_SECRETS,
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("ok");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });
});
