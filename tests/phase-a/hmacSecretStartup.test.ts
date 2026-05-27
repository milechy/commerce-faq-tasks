// tests/phase-a/hmacSecretStartup.test.ts
//
// Codex review #3/#4 反映: 実コード src/lib/startup/internalSecretGuard.ts を
// 直接 import して、本物の startup ガード判定をテストする
// （ローカル再実装の false-confidence を排除）。

import {
  assertInternalSecretConfigured,
  evaluateInternalSecretGuard,
} from "../../src/lib/startup/internalSecretGuard";

function silentLogger() {
  return {
    warn: jest.fn(),
    fatal: jest.fn(),
  };
}

describe("evaluateInternalSecretGuard (Codex #4 — invert NODE_ENV gating)", () => {
  it("secret 設定済 → ok / mustExit=false", () => {
    expect(
      evaluateInternalSecretGuard({ INTERNAL_API_HMAC_SECRET: "x", NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toEqual(expect.objectContaining({ result: "ok", mustExit: false }));
  });

  it("secret 未設定 + NODE_ENV=production → mustExit=true (fail-fast)", () => {
    const out = evaluateInternalSecretGuard({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
    expect(out.reason).toMatch(/non-safe-env-production/);
  });

  it("secret 未設定 + NODE_ENV=staging → mustExit=true (Codex #4: production だけに限定しない)", () => {
    const out = evaluateInternalSecretGuard({ NODE_ENV: "staging" } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
  });

  it("secret 未設定 + NODE_ENV 未定義 → mustExit=true (Codex #4: 未設定/typo もブロック)", () => {
    const out = evaluateInternalSecretGuard({} as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
    expect(out.reason).toMatch(/undefined/);
  });

  it("secret 未設定 + NODE_ENV=production-typo → mustExit=true", () => {
    const out = evaluateInternalSecretGuard({ NODE_ENV: "Production" } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
  });

  it("secret 未設定 + NODE_ENV=development → warn / mustExit=false", () => {
    const out = evaluateInternalSecretGuard({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(out.result).toBe("warn");
    expect(out.mustExit).toBe(false);
  });

  it("secret 未設定 + NODE_ENV=test → warn / mustExit=false (Jest 環境)", () => {
    const out = evaluateInternalSecretGuard({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(out.result).toBe("warn");
    expect(out.mustExit).toBe(false);
  });

  // Codex review #5: production で bypass を試みても無効、必ず fail-fast。
  it("secret 未設定 + production + ALLOW_MISSING_INTERNAL_HMAC_SECRET=true → bypass しない (Codex #5)", () => {
    const out = evaluateInternalSecretGuard({
      NODE_ENV: "production",
      ALLOW_MISSING_INTERNAL_HMAC_SECRET: "true",
    } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
    expect(out.reason).toMatch(/production/);
  });

  it("secret 未設定 + staging + ALLOW_MISSING_INTERNAL_HMAC_SECRET=true → bypass しない", () => {
    const out = evaluateInternalSecretGuard({
      NODE_ENV: "staging",
      ALLOW_MISSING_INTERNAL_HMAC_SECRET: "true",
    } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
  });

  it("secret 未設定 + 不明env + ALLOW_MISSING_INTERNAL_HMAC_SECRET=true → bypass しない", () => {
    const out = evaluateInternalSecretGuard({
      ALLOW_MISSING_INTERNAL_HMAC_SECRET: "true",
    } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
  });

  it("secret 未設定 + 任意の追加 env を渡しても production では mustExit=true", () => {
    const out = evaluateInternalSecretGuard({
      NODE_ENV: "production",
      DEBUG: "true",
      FORCE_BYPASS: "1",
      ALLOW_ANYTHING: "yes",
    } as NodeJS.ProcessEnv);
    expect(out.mustExit).toBe(true);
  });
});

describe("assertInternalSecretConfigured (Codex #4 — exit path)", () => {
  it("production + secret 未設定 → onFatal が呼ばれて 例外 throw", () => {
    const logger = silentLogger();
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT_CALLED__");
    });
    expect(() =>
      assertInternalSecretConfigured(
        logger,
        { NODE_ENV: "production" } as NodeJS.ProcessEnv,
        onFatal as unknown as () => never,
      ),
    ).toThrow("__EXIT_CALLED__");
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
  });

  it("development + secret 未設定 → onFatal 未呼び出し、warn のみ", () => {
    const logger = silentLogger();
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT_CALLED__");
    });
    const out = assertInternalSecretConfigured(
      logger,
      { NODE_ENV: "development" } as NodeJS.ProcessEnv,
      onFatal as unknown as () => never,
    );
    expect(out).toBe("warn");
    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("production + secret 設定済 → ok 返却、警告なし", () => {
    const logger = silentLogger();
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT_CALLED__");
    });
    const out = assertInternalSecretConfigured(
      logger,
      { NODE_ENV: "production", INTERNAL_API_HMAC_SECRET: "secret" } as NodeJS.ProcessEnv,
      onFatal as unknown as () => never,
    );
    expect(out).toBe("ok");
    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });
});
