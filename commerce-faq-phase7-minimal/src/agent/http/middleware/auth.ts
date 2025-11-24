// src/agent/http/middleware/auth.ts
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

export function createAuthMiddleware(logger: pino.Logger) {
  const apiKey = process.env.AGENT_API_KEY || "";
  const basicUser = process.env.AGENT_BASIC_USER || "";
  const basicPass = process.env.AGENT_BASIC_PASSWORD || "";

  const authDisabled = !apiKey && !basicUser && !basicPass;

  if (authDisabled) {
    logger.warn(
      "Auth middleware is DISABLED (no AGENT_API_KEY / AGENT_BASIC_USER set)"
    );
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
    if (authDisabled) {
      return next();
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
