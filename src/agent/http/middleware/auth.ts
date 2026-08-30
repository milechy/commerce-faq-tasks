// src/agent/http/middleware/auth.ts
// @deprecated — Use initAuthMiddleware from "../authMiddleware" instead.
// This file is kept only for backward compatibility and will be removed.
import type { NextFunction, Request, Response } from "express";
import type pino from "pino";

const HEADER_API_KEY = "x-api-key";

function parseBasicAuth(
  authorizationHeader: string | undefined
): { user: string; pass: string } | null {
  if (!authorizationHeader) return null;
  if (!authorizationHeader.startsWith("Basic ")) return null;

  const base64 = authorizationHeader.slice("Basic ".length).trim();
  if (!base64) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return null;
  }

  const idx = decoded.indexOf(":");
  if (idx === -1) return null;

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  return { user, pass };
}

const SAFE_INSECURE_AUTH_ENVS = new Set(["development", "test"]);

export function createAuthMiddleware(logger: pino.Logger) {
  const apiKey = process.env.AGENT_API_KEY || "";
  const basicUser = process.env.AGENT_BASIC_USER || "";
  const basicPass = process.env.AGENT_BASIC_PASSWORD || "";

  const noCredentialsConfigured = !apiKey && !basicUser && !basicPass;

  // [P1 fail-closed] 認証情報が全未設定でも「素通し」しない。
  // 従来は AGENT_API_KEY / AGENT_BASIC_USER / AGENT_BASIC_PASSWORD が全て未設定だと
  // 認証を無効化して next() する fail-open だった（本番で env 投入漏れ＝認証全開放）。
  // ローカル開発で意図的に無効化したい場合のみ、非production かつ
  // ALLOW_INSECURE_AGENT_AUTH=1 の明示 opt-in を要求する。
  const insecureBypassOptIn =
    !SAFE_INSECURE_AUTH_ENVS.has(process.env.NODE_ENV ?? "")
      ? false
      : process.env.ALLOW_INSECURE_AGENT_AUTH === "1" ||
        process.env.ALLOW_INSECURE_AGENT_AUTH === "true";
  const authBypassed = noCredentialsConfigured && insecureBypassOptIn;

  if (noCredentialsConfigured) {
    if (authBypassed) {
      logger.warn(
        "Auth middleware BYPASSED (no credentials set + ALLOW_INSECURE_AGENT_AUTH opt-in, dev/test only)"
      );
    } else {
      // 素通しはしない。資格情報が無いので全リクエストを 503 で拒否する（fail-closed）。
      logger.error(
        "Auth middleware has NO credentials configured (AGENT_API_KEY / AGENT_BASIC_USER / AGENT_BASIC_PASSWORD). " +
          "Rejecting all requests (fail-closed). Set credentials, or set ALLOW_INSECURE_AGENT_AUTH=1 with NODE_ENV=development|test."
      );
    }
  } else {
    logger.info(
      {
        hasApiKey: !!apiKey,
        hasBasic: !!(basicUser && basicPass),
      },
      "Auth middleware initialized"
    );
  }

  return function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    logger.info(
      {
        path: req.path,
        method: req.method,
        hasApiKeyHeader: !!req.header(HEADER_API_KEY),
        hasAuthHeader: !!req.header("authorization"),
      },
      "auth middleware invoked"
    );
    if (authBypassed) {
      return next();
    }
    if (noCredentialsConfigured) {
      // fail-closed: 資格情報未設定で opt-in も無い → 常に拒否。
      return res.status(503).json({
        error: "auth_not_configured",
        message: "Server authentication is not configured",
      });
    }

    // 1. API Key (X-API-Key)
    if (apiKey) {
      const headerKey = req.header(HEADER_API_KEY);
      if (headerKey && headerKey === apiKey) {
        return next();
      }
    }

    // 2. Basic Auth
    if (basicUser && basicPass) {
      const parsed = parseBasicAuth(req.header("authorization"));
      if (parsed && parsed.user === basicUser && parsed.pass === basicPass) {
        return next();
      }
    }

    logger.warn(
      {
        path: req.path,
        method: req.method,
        hasApiKeyHeader: !!req.header(HEADER_API_KEY),
        hasAuthHeader: !!req.header("authorization"),
      },
      "Unauthorized request rejected"
    );

    return res.status(401).json({
      error: "unauthorized",
      message: "Invalid or missing credentials",
    });
  };
}
