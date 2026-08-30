// src/lib/startup/authSecretsGuard.ts
//
// [P1 fail-closed] 認証/署名/暗号に関わる必須 secret の起動時 invariant。
// internalSecretGuard.ts と同じ「fail-closed-by-default」パターンに倣う。
//
// 対象 secret:
//   - SUPABASE_JWT_SECRET     管理面 JWT の署名検証鍵（欠落→認証が実質無効化）
//   - WIDGET_JWT_SECRET       widget 配布トークンの署名鍵（欠落→署名/検証不能）
//   - KNOWLEDGE_ENCRYPTION_KEY 知識/書籍テキストの暗号化鍵（欠落→平文保存 fail-open）
//
// Policy（NODE_ENV に依らない invariant。undefined/staging も fail-closed 側に倒す）:
//   - すべて SET                                        → "ok"
//   - いずれか UNSET, NODE_ENV ∈ {development,test}     → "warn"（loud log, 続行）
//   - いずれか UNSET, それ以外（production/staging/未設定）→ onFatal()（process.exit(1)）
//
// config/env.ts の production 必須化（SUPABASE_JWT_SECRET / WIDGET_JWT_SECRET /
// KNOWLEDGE_ENCRYPTION_KEY）はスキーマ層の二重防御。ここは NODE_ENV=production を
// 名乗らない誤起動（NODE_ENV 未設定など）でも secret 欠落を確実に捕捉する。

export type GuardResult = "ok" | "warn";

const SAFE_NON_PROD_ENVS = new Set(["development", "test"]);

// 起動をブロックする必須 secret。空白のみの値は未設定と同義に扱う。
const REQUIRED_SECRETS = [
  "SUPABASE_JWT_SECRET",
  "WIDGET_JWT_SECRET",
  "KNOWLEDGE_ENCRYPTION_KEY",
] as const;

export function evaluateAuthSecretsGuard(env: NodeJS.ProcessEnv = process.env): {
  result: GuardResult;
  mustExit: boolean;
  missing: string[];
  reason: string;
} {
  const missing = REQUIRED_SECRETS.filter((name) => !env[name]?.trim());

  if (missing.length === 0) {
    return { result: "ok", mustExit: false, missing, reason: "all-secrets-present" };
  }

  const nodeEnv = env.NODE_ENV ?? "";
  if (SAFE_NON_PROD_ENVS.has(nodeEnv)) {
    return {
      result: "warn",
      mustExit: false,
      missing,
      reason: `secret-missing-env-${nodeEnv}`,
    };
  }

  return {
    result: "warn",
    mustExit: true,
    missing,
    reason: `secret-missing-non-safe-env-${nodeEnv || "undefined"}`,
  };
}

export interface AuthSecretsGuardLogger {
  warn: (msg: string) => void;
  fatal: (msg: string) => void;
}

/**
 * 起動時に呼ぶ。認証/署名/暗号 secret 欠落 + production/staging/不明 env では exit(1)。
 * 戻り値は "ok" or "warn"。
 */
export function assertAuthSecretsConfigured(
  logger: AuthSecretsGuardLogger,
  env: NodeJS.ProcessEnv = process.env,
  onFatal: () => never = () => process.exit(1) as never,
): GuardResult {
  const { result, mustExit, missing, reason } = evaluateAuthSecretsGuard(env);
  if (mustExit) {
    logger.fatal(
      `[startup] Missing required auth/crypto secrets: ${missing.join(", ")} ` +
        `(reason=${reason}). Aborting boot to avoid fail-open auth/plaintext storage. ` +
        "Set the missing secrets, or set NODE_ENV=development|test for non-production runs.",
    );
    onFatal();
  }
  if (result === "warn") {
    logger.warn(
      `[startup] Missing auth/crypto secrets: ${missing.join(", ")} (reason=${reason}). ` +
        "OK for dev/test, FATAL in production. Affected: admin auth / widget signing / knowledge encryption.",
    );
  }
  return result;
}
