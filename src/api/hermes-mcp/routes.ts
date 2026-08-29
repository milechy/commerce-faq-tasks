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
import {
  isHermesDataConsentGranted,
  listHermesConsentingTenantIds,
  shareConsentSqlPredicate,
} from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { getRuleEffect } from "../admin/analytics/ruleEffect";
import { getPool } from "../../lib/db";
import { createNotification } from "../../lib/notifications";
import { logger } from "../../lib/logger";

const MAX_QUERY_LEN = 200;
const MAX_TEXT_LEN = 2000;

// GET /proposals のページング。既存 GET /conversations の作法(hermesMcpRepository.ts の
// MAX_LIMIT/DEFAULT_LIMIT)に合わせる。
const PROPOSALS_MAX_LIMIT = 200;
const PROPOSALS_DEFAULT_LIMIT = 50;

type HermesProposalScope = "global" | "tenant";
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

    // R6: 提案の受け皿を1つにする。hermes_strategy_proposals を承認導線として
    // 育てず、Judge提案と同じ tuning_rules に着地させる(source='hermes',
    // is_active=false, status='pending')。承認は既存の
    // approveTuningRule/rejectTuningRule/updateRule(D8で is_active との
    // 整合性を保証済み)がそのまま使える。
    //
    // trigger_pattern には title をそのまま使う。Hermes の title は
    // 「保証期間の即答」のような短い要約であり、matchesTriggerPattern の
    // キーワード一致には必ずしも最適ではない(insertTuningRuleFromSuggestion
    // の是正と同じ既知の限界)。承認者は copilot-preview 等で承認時に
    // trigger_pattern を編集できる。
    //
    // scope='global' は tuning_rules の既存の慣習(tenant_id='global')に
    // 合わせる(getActiveRulesForTenant が tenant_id=$1 OR tenant_id='global'
    // で読む)。
    const tenantIdValue = scope === "tenant" ? (tenant_id as string) : "global";
    const evidenceJson = JSON.stringify({
      ...(evidence as Record<string, unknown> | undefined),
      rationale,
    });

    try {
      const pool = getPool();
      const result = await pool.query<{ id: number }>(
        `INSERT INTO tuning_rules
           (tenant_id, trigger_pattern, expected_behavior, priority, is_active,
            source, status, evidence, dedup_key)
         VALUES ($1, $2, $3, 0, false, 'hermes', 'pending', $4::jsonb, $5)
         ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantIdValue, title, suggested_action, evidenceJson, dedup_key],
      );

      const insertedId = result.rows[0]?.id ?? null;
      if (insertedId === null) {
        return res.json({ duplicate: true });
      }

      try {
        await createNotification({
          recipientRole: scope === "global" ? "super_admin" : "client_admin",
          recipientTenantId: scope === "tenant" ? (tenant_id as string) : undefined,
          type: "hermes_proposal",
          title,
          message: rationale,
          // R6: 実在するルートのみを指す。Hermes提案は tuning_rules の
          // 承認一覧(AIReportTab / copilot-preview get_tuning_rules)に
          // Judge提案と同じ形で並ぶ。global scope はテナント固有ページが
          // 無いためテナント一覧へ誘導する。
          link: scope === "global" ? "/admin/tenants" : `/admin/tenants/${tenant_id as string}`,
          metadata: { tuning_rule_id: insertedId, dedup_key, scope },
        });
      } catch (err) {
        logger.warn({ err }, "[hermes-mcp] proposal notification failed (non-fatal)");
      }

      return res.status(201).json({ proposal_id: String(insertedId), duplicate: false });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] insert proposal failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/proposals
  // Hermesが過去に投稿した自分の提案の判断結果(pending/active/rejected)を
  // 読み戻すための学習ループの口。R6により提案は hermes_strategy_proposals
  // ではなく tuning_rules(source='hermes') に着地しているため、ここでも
  // tuning_rules を読む(受け皿を1つに保つ。第2の永続化経路を作らない)。
  //
  // 越境防止: scope='tenant' の行(tenant_id != 'global')は同意済みテナントの
  // ものだけ返す。同意判定は必ず shareConsentSqlPredicate() を使い、生SQLで
  // 判定ロジックを再実装しない(過去にJSとSQLの判定が食い違いタダ乗りが成立した
  // 経緯があるため。詳細は hermesConsent.ts の shareConsentSqlPredicate 参照)。
  // scope='global' の行(tenant_id='global')は同意済みテナントの会話を横断
  // 分析した結果に基づく(migration_phase74_hermes_strategy_proposals.sql の
  // 設計コメント参照)ため、無条件に返してよい。
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/proposals", async (req: Request, res: Response) => {
    const rawLimit = req.query["limit"];
    let limit = PROPOSALS_DEFAULT_LIMIT;
    if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > PROPOSALS_MAX_LIMIT) {
        return res.status(400).json({ error: "invalid_limit" });
      }
      limit = parsed;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{
        id: number;
        tenant_id: string;
        trigger_pattern: string;
        status: string;
        dedup_key: string | null;
        approved_at: string | null;
        rejected_at: string | null;
        created_at: string;
      }>(
        `SELECT id, tenant_id, trigger_pattern, status, dedup_key, approved_at, rejected_at, created_at
           FROM tuning_rules tr
          WHERE tr.source = 'hermes'
            AND (
              tr.tenant_id = 'global'
              OR EXISTS (
                SELECT 1 FROM tenants t
                 WHERE t.id = tr.tenant_id
                   AND ${shareConsentSqlPredicate("t.features")}
              )
            )
          ORDER BY tr.created_at DESC
          LIMIT $1`,
        [limit],
      );

      // 採用後の効果測定: 既存の DiD 効果集計(getRuleEffect、
      // /v1/admin/analytics/rule-effect/:ruleId と同じロジック)を再利用する
      // (実装を2箇所に持たない)。status='active'(承認済み)の提案のみ
      // before/afterのafter区間が存在するため対象にする。
      const proposals = await Promise.all(
        result.rows.map(async (row) => {
          const scope: HermesProposalScope = row.tenant_id === "global" ? "global" : "tenant";
          const effect = row.status === "active" ? await getRuleEffect(pool, row.id) : null;

          return {
            proposal_id: String(row.id),
            scope,
            tenant_id: scope === "tenant" ? row.tenant_id : undefined,
            title: row.trigger_pattern,
            status: row.status,
            dedup_key: row.dedup_key,
            decided_at: row.approved_at ?? row.rejected_at ?? null,
            created_at: row.created_at,
            effect,
          };
        }),
      );

      return res.json({ proposals });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] list proposals failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
