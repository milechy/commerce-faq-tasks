// src/api/hermes-mcp/hermesMcpAuth.ts
// Phase75: Hermes MCP エンドポイント用 Bearer トークン認証
//
// 呼び出し元(Hermes Agent VPS)は R2C 本番VPSとは別ホストのため、
// internalNetworkOnly(loopback限定)パターンは使えない。
// 代わりに HERMES_MCP_API_KEY 環境変数との定数時間比較で認証する。
// 生の文字列同士を timingSafeEqual すると長さ不一致で例外/タイミング漏洩の
// リスクがあるため、SHA-256ダイジェスト同士(常に32byte固定長)を比較する。

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

export function hermesMcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.HERMES_MCP_API_KEY;
  if (!expected) {
    // 未設定(開発環境等)では機能全体をfail-closedで無効化する
    res.status(503).json({ error: "hermes_mcp_not_configured" });
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }
  const provided = authHeader.slice("Bearer ".length).trim();

  const providedHash = sha256(provided);
  const expectedHash = sha256(expected);
  if (!timingSafeEqual(providedHash, expectedHash)) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  next();
}
