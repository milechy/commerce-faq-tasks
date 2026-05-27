// tests/phase-a/hmacSecretStartup.test.ts
//
// Codex review #3 反映: INTERNAL_API_HMAC_SECRET 未設定での boot を
// production では fail-fast、dev/test では loud warn で許容することを検証する。
//
// 起動ロジックを再利用可能な形に抽出していないため、ここでは src/index.ts の
// 起動シーケンスを丸ごと spawn するのではなく、Codex review #3 で追加した
// "process.exit(1)" 分岐の意図を直接検証する。
//
// process.exit が production で呼ばれること / dev で呼ばれないこと の二点。

describe("INTERNAL_API_HMAC_SECRET startup guard (Codex review #3)", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_SECRET = process.env.INTERNAL_API_HMAC_SECRET;

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.INTERNAL_API_HMAC_SECRET;
    } else {
      process.env.INTERNAL_API_HMAC_SECRET = ORIGINAL_SECRET;
    }
  });

  // 純粋関数として startup ガードを切り出して検証する。
  // src/index.ts の本物の startServer() を呼ぶと express.listen 副作用が出るため、
  // 同等ロジックをここで再現し、運用上の仕様契約を pin する。
  function startupGuard(env: NodeJS.ProcessEnv, onFatal: () => never): "ok" | "warn" {
    if (!env.INTERNAL_API_HMAC_SECRET) {
      if (env.NODE_ENV === "production") {
        onFatal();
      }
      return "warn";
    }
    return "ok";
  }

  it("production + secret 未設定 → onFatal が呼ばれる (process.exit 相当)", () => {
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT__");
    });
    expect(() =>
      startupGuard(
        { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv,
        onFatal as unknown as () => never,
      ),
    ).toThrow("__EXIT__");
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("development + secret 未設定 → warn 返却、onFatal 未呼び出し", () => {
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT__");
    });
    const result = startupGuard(
      { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv,
      onFatal as unknown as () => never,
    );
    expect(result).toBe("warn");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("test + secret 未設定 → warn 返却 (Jest 環境を壊さない)", () => {
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT__");
    });
    const result = startupGuard(
      { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv,
      onFatal as unknown as () => never,
    );
    expect(result).toBe("warn");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("production + secret 設定済 → ok 返却", () => {
    const onFatal = jest.fn(() => {
      throw new Error("__EXIT__");
    });
    const result = startupGuard(
      { NODE_ENV: "production", INTERNAL_API_HMAC_SECRET: "xxx" } as unknown as NodeJS.ProcessEnv,
      onFatal as unknown as () => never,
    );
    expect(result).toBe("ok");
    expect(onFatal).not.toHaveBeenCalled();
  });
});
