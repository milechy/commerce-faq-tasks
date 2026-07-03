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
import { createHermesProposalRepository, type HermesProposalScope } from "./proposalRepository";
import { createNotification } from "../../lib/notifications";
import { logger } from "../../lib/logger";

const MAX_QUERY_LEN = 200;
const MAX_TEXT_LEN = 2000;

const VALID_PROPOSAL_SCOPES: readonly HermesProposalScope[] = ["global", "tenant"];

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

  // ----------------------------------------------------------------
  // POST /v1/hermes-mcp/proposals
  // Hermes Agent(外部)がCVR改善提案を投稿するためのエンドポイント。
  // system_prompt等は一切自動書き換えしない(提案→人間承認ゲート)。
  // ----------------------------------------------------------------
  app.post("/v1/hermes-mcp/proposals", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { scope, tenant_id, title, rationale, suggested_action, evidence, dedup_key } = body as {
      scope?: unknown;
      tenant_id?: unknown;
      title?: unknown;
      rationale?: unknown;
      suggested_action?: unknown;
      evidence?: unknown;
      dedup_key?: unknown;
    };

    if (typeof scope !== "string" || !VALID_PROPOSAL_SCOPES.includes(scope as HermesProposalScope)) {
      return res.status(400).json({ error: "invalid_scope" });
    }
    if (scope === "tenant" && (typeof tenant_id !== "string" || !tenant_id)) {
      return res.status(400).json({ error: "tenant_id required for scope=tenant" });
    }
    if (scope === "global" && tenant_id !== undefined) {
      return res.status(400).json({ error: "tenant_id must be omitted for scope=global" });
    }
    if (typeof title !== "string" || !title.trim() || title.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_title" });
    }
    if (typeof rationale !== "string" || !rationale.trim() || rationale.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_rationale" });
    }
    if (typeof suggested_action !== "string" || !suggested_action.trim() || suggested_action.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_suggested_action" });
    }
    if (typeof dedup_key !== "string" || !dedup_key.trim()) {
      return res.status(400).json({ error: "invalid_dedup_key" });
    }
    if (evidence !== undefined && (typeof evidence !== "object" || evidence === null || Array.isArray(evidence))) {
      return res.status(400).json({ error: "invalid_evidence" });
    }

    // 同意チェック(defense in depth): search_conversationsは既に同意済みテナントしか
    // 返さないが、Hermes側の実装ミス・改ざんに備えてここでも必ず再検証する。
    if (scope === "tenant") {
      const consented = await isHermesDataConsentGranted(tenant_id as string);
      if (!consented) {
        return res.status(403).json({ error: "tenant_not_consented" });
      }
    }

    const repo = createHermesProposalRepository();
    try {
      const inserted = await repo.insertProposal({
        scope: scope as HermesProposalScope,
        tenantId: scope === "tenant" ? (tenant_id as string) : undefined,
        title,
        rationale,
        suggestedAction: suggested_action,
        evidence: (evidence as Record<string, unknown>) ?? {},
        dedupKey: dedup_key,
      });

      if (!inserted) {
        return res.json({ duplicate: true });
      }

      const proposalId = await repo.findProposalIdByDedupKey(dedup_key);

      try {
        await createNotification({
          recipientRole: scope === "global" ? "super_admin" : "client_admin",
          recipientTenantId: scope === "tenant" ? (tenant_id as string) : undefined,
          type: "hermes_proposal",
          title,
          message: rationale,
          link: scope === "global" ? "/admin/hermes" : "/admin/conversion",
          metadata: { proposal_id: proposalId, dedup_key, scope },
        });
      } catch (err) {
        logger.warn({ err }, "[hermes-mcp] proposal notification failed (non-fatal)");
      }

      return res.status(201).json({ proposal_id: proposalId, duplicate: false });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] insert proposal failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
