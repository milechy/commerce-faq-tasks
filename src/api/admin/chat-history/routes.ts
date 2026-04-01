// src/api/admin/chat-history/routes.ts
// Phase38 Step2: 会話履歴取得API

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { getSessions, getMessages } from "./chatHistoryRepository";
import { createNotification } from "../../../lib/notifications";

/**
 * テナントIDをリクエストから解決する。
 * - super_admin: query ?tenant=xxx を許可
 * - client_admin: JWT 由来の自テナントのみ（CLAUDE.md: tenantId は body から禁止）
 */
function resolveTenantFilter(
  req: Request,
  jwtTenantId: string,
  isSuperAdmin: boolean,
): string | undefined {
  if (isSuperAdmin) {
    const fromQuery = req.query["tenant"] as string | undefined;
    return fromQuery || undefined; // 指定なし = 全テナント
  }
  return jwtTenantId; // client_admin は自テナント強制
}

export function registerChatHistoryRoutes(app: Express): void {
  // 認証ミドルウェアを適用
  app.use("/v1/admin/chat-history", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/chat-history/sessions
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/chat-history/sessions",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      const tenantFilter = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      const limit = Math.max(1, Math.min(parseInt((req.query["limit"] as string) ?? "20", 10) || 20, 200));
      const offset = Math.max(0, parseInt((req.query["offset"] as string) ?? "0", 10) || 0);

      // Phase52b: sort/filter params
      const validSortBy = ["last_message_at", "message_count", "score"] as const;
      const sortByParam = req.query["sort_by"] as string | undefined;
      const sort_by = validSortBy.includes(sortByParam as typeof validSortBy[number])
        ? (sortByParam as typeof validSortBy[number])
        : undefined;
      const sortOrderParam = req.query["sort_order"] as string | undefined;
      const sort_order = sortOrderParam === "asc" ? "asc" : sortOrderParam === "desc" ? "desc" : undefined;

      const validPeriods = ["7", "30", "90", "all"] as const;
      const periodParam = req.query["period"] as string | undefined;
      const period = validPeriods.includes(periodParam as typeof validPeriods[number])
        ? (periodParam as typeof validPeriods[number])
        : undefined;

      const validSentiments = ["positive", "negative", "neutral"] as const;
      const sentimentParam = req.query["sentiment"] as string | undefined;
      const sentiment = validSentiments.includes(sentimentParam as typeof validSentiments[number])
        ? (sentimentParam as typeof validSentiments[number])
        : undefined;

      const search = (req.query["search"] as string | undefined)?.trim() ?? undefined;

      try {
        const result = await getSessions({
          tenantId: tenantFilter,
          limit,
          offset,
          sort_by,
          sort_order,
          period,
          sentiment,
          search,
        });

        return res.json({
          sessions: result.sessions,
          total: result.total,
          limit,
          offset,
        });
      } catch (err) {
        console.warn("[GET /v1/admin/chat-history/sessions]", err);
        return res.status(500).json({ error: "セッション一覧の取得に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/chat-history/sessions/:sessionId/messages
  // :sessionId = chat_sessions.id (UUID)
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/chat-history/sessions/:sessionId/messages",
    async (req: Request, res: Response) => {
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

      // テナント検証:
      //   super_admin: ?tenant=xxx があればそれを使う。なければ undefined (全セッション閲覧可)
      //   client_admin: JWT 由来の自テナントのみ必須
      const tenantId: string | undefined = isSuperAdmin
        ? ((req.query["tenant"] as string | undefined) || undefined)
        : jwtTenantId;

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }
      if (!isSuperAdmin && !tenantId) {
        return res.status(400).json({ error: "tenant が解決できません" });
      }

      try {
        const messages = await getMessages({ sessionDbId, tenantId });

        // messages が空 = セッションが存在しないかテナント不一致
        if (messages.length === 0) {
          // 存在確認は getMessages 内で実施済みなので 404 で返す
          return res.status(404).json({ error: "セッションが見つかりません" });
        }

        return res.json({ messages, total: messages.length });
      } catch (err) {
        console.warn("[GET /v1/admin/chat-history/sessions/:id/messages]", err);
        return res.status(500).json({ error: "メッセージの取得に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/chat-history/sessions/:sessionId/outcome
  // Phase52f: コンバージョン結果を chat_sessions に記録
  // :sessionId = chat_sessions.id (UUID)
  // Body: { outcome: string }
  // -----------------------------------------------------------------------
  app.patch(
    "/v1/admin/chat-history/sessions/:sessionId/outcome",
    async (req: Request, res: Response) => {
      const pool = getPool();
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
      const email: string = su?.email ?? su?.app_metadata?.email ?? "";

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }

      const { outcome } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof outcome !== "string" || !outcome.trim()) {
        return res.status(400).json({ error: "outcome は必須の文字列です" });
      }
      const outcomeValue = outcome.trim();

      try {
        // セッション取得 + テナント確認
        const sessionResult = await pool.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM chat_sessions WHERE id = $1`,
          [sessionDbId],
        );
        if (sessionResult.rows.length === 0) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }
        const session = sessionResult.rows[0];

        // テナント分離チェック
        if (!isSuperAdmin && session.tenant_id !== jwtTenantId) {
          return res.status(403).json({ error: "このセッションへのアクセス権がありません" });
        }

        // テナントの conversion_types でバリデーション
        const tenantResult = await pool.query<{ conversion_types: string[] | null }>(
          `SELECT conversion_types FROM tenants WHERE id = $1`,
          [session.tenant_id],
        );
        const conversionTypes: string[] = tenantResult.rows[0]?.conversion_types ??
          ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"];
        if (!conversionTypes.includes(outcomeValue)) {
          return res.status(400).json({
            error: "指定されたoutcomeはこのテナントのconversion_typesに含まれていません",
            valid_outcomes: conversionTypes,
          });
        }

        // 記録
        await pool.query(
          `UPDATE chat_sessions
           SET outcome = $1, outcome_recorded_at = NOW(), outcome_recorded_by = $2
           WHERE id = $3`,
          [outcomeValue, email || null, sessionDbId],
        );

        // Phase52h: Trigger 5 — outcome記録通知
        void createNotification({
          recipientRole: 'super_admin',
          type: 'outcome_recorded',
          title: 'コンバージョン結果が記録されました',
          message: `「${outcomeValue}」が記録されました`,
          link: '/admin/analytics',
          metadata: { sessionId: sessionDbId, outcome: outcomeValue, tenantId: session!.tenant_id },
        });

        return res.json({
          sessionId: sessionDbId,
          outcome: outcomeValue,
          recorded_at: new Date().toISOString(),
          recorded_by: email || null,
        });
      } catch (err) {
        console.warn("[PATCH /v1/admin/chat-history/sessions/:id/outcome]", err);
        return res.status(500).json({ error: "結果の記録に失敗しました" });
      }
    },
  );
}
