// src/lib/startup/internalSecretGuard.ts
//
// Boot-time validation for INTERNAL_API_HMAC_SECRET.
//
// Codex review #3/#4: the missing-secret partial-outage scenario must be caught
// at boot, not at request time. Codex #4 also flagged that gating on
// `NODE_ENV === "production"` is brittle — a process started with NODE_ENV
// unset or non-canonical would slip past the guard and degrade silently.
//
// Policy (fail-closed-by-default):
//   - secret SET                                    → "ok"
//   - secret UNSET, NODE_ENV ∈ {development,test}   → "warn"  (loud log, continue)
//   - secret UNSET, anything else (incl. undefined) → onFatal() (process.exit(1))
//
// Escape hatch: if a user explicitly opts in via
// ALLOW_MISSING_INTERNAL_HMAC_SECRET=true (e.g. ephemeral container running an
// admin-only command path that does not touch /internal/ga4/*), the guard
// downgrades to "warn". This must be an explicit signal, never the default.

export type GuardResult = "ok" | "warn";

const SAFE_NON_PROD_ENVS = new Set(["development", "test"]);

export function evaluateInternalSecretGuard(
  env: NodeJS.ProcessEnv = process.env,
): { result: GuardResult; mustExit: boolean; reason: string } {
  if (env.INTERNAL_API_HMAC_SECRET) {
    return { result: "ok", mustExit: false, reason: "secret-present" };
  }
  if (env.ALLOW_MISSING_INTERNAL_HMAC_SECRET === "true") {
    return {
      result: "warn",
      mustExit: false,
      reason: "secret-missing-explicit-bypass",
    };
  }
  const nodeEnv = env.NODE_ENV ?? "";
  if (SAFE_NON_PROD_ENVS.has(nodeEnv)) {
    return { result: "warn", mustExit: false, reason: `secret-missing-env-${nodeEnv}` };
  }
  return {
    result: "warn",
    mustExit: true,
    reason: `secret-missing-non-safe-env-${nodeEnv || "undefined"}`,
  };
}

export interface InternalSecretGuardLogger {
  warn: (msg: string) => void;
  fatal: (msg: string) => void;
}

/**
 * 起動時に呼ぶ。secret 欠落 + production/staging/不明 env では exit(1)。
 * 戻り値は "ok" or "warn"。
 */
export function assertInternalSecretConfigured(
  logger: InternalSecretGuardLogger,
  env: NodeJS.ProcessEnv = process.env,
  onFatal: () => never = () => process.exit(1) as never,
): GuardResult {
  const { result, mustExit, reason } = evaluateInternalSecretGuard(env);
  if (mustExit) {
    logger.fatal(
      `[startup] INTERNAL_API_HMAC_SECRET is required (reason=${reason}). ` +
        "/internal/ga4/* would 500 indefinitely. Aborting boot. " +
        "Set the secret, or set ALLOW_MISSING_INTERNAL_HMAC_SECRET=true to bypass.",
    );
    onFatal();
  }
  if (result === "warn") {
    logger.warn(
      `[startup] INTERNAL_API_HMAC_SECRET not set (reason=${reason}). ` +
        "/internal/ga4/* will fail-closed (500). OK for dev/test, FATAL in production.",
    );
  }
  return result;
}
