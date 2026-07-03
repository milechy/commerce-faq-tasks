// src/api/hermes-mcp/routes.ts
// Phase75: Hermes Agent(CVR学習エージェント)向けMCPデータエンドポイント
//
// GET /v1/hermes-mcp/tenants        — 同意済みテナントID一覧
// GET /v1/hermes-mcp/conversations  — 会話メッセージ検索(同意済みテナントのみ)
//
// 認証: Bearer HERMES_MCP_API_KEY(hermesMcpAuthMiddleware、定数時間比較)。
// 呼び出し元は Hermes Agent VPS(135.181.194.34)上の stdio MCP サーバーラッパー。
//
// 設計上の要: 同意チェックは他の何よりも先に行う。tenant_id が
// listHermesConsentingTenantIds() に含まれない限り、絶対にデータへ到達させない。

import type { Express, Request, Response } from "express";
import { hermesMcpAuthMiddleware } from "./hermesMcpAuth";
import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { logger } from "../../lib/logger";

const MAX_QUERY_LEN = 200;

export function registerHermesMcpRoutes(app: Express): void {
  app.use("/v1/hermes-mcp", hermesMcpAuthMiddleware);

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/tenants
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/tenants", async (_req: Request, res: Response) => {
    try {
      const tenantIds = await listHermesConsentingTenantIds();
      return res.json({ tenantIds });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] list tenants failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/conversations
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/conversations", async (req: Request, res: Response) => {
    const tenantId = req.query["tenant_id"];
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id required" });
    }

    // 同意チェックを最優先で実行(他の何よりも先)。
    // 未同意テナントには、存在確認すら与えないよう 403 で統一する。
    const consented = await isHermesDataConsentGranted(tenantId);
    if (!consented) {
      return res.status(403).json({ error: "tenant_not_consented" });
    }

    const rawQuery = req.query["query"];
    const query =
      typeof rawQuery === "string" && rawQuery.trim().length > 0
        ? rawQuery.slice(0, MAX_QUERY_LEN)
        : undefined;

    const rawMinScore = req.query["min_judge_score"];
    let minJudgeScore: number | undefined;
    if (typeof rawMinScore === "string" && rawMinScore.trim() !== "") {
      const parsed = Number(rawMinScore);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: "invalid_min_judge_score" });
      }
      minJudgeScore = parsed;
    }

    const convertedOnly = req.query["converted_only"] === "true";

    const rawLimit = req.query["limit"];
    let limit: number | undefined;
    if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
        return res.status(400).json({ error: "invalid_limit" });
      }
      limit = parsed;
    }

    try {
      const conversations = await searchConversations({
        tenantId,
        query,
        minJudgeScore,
        convertedOnly,
        limit,
      });
      return res.json({ conversations });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] search conversations failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
