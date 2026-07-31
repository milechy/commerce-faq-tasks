// src/api/admin/chat-history/routes.ts

// Phase38 Step2: 会話履歴取得API

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { getSessions, getMessages, getActiveEscalations, resolveEscalation, saveMessage, normalizeSessionListParams, getConversionTypes, recordOutcome } from "./chatHistoryRepository";
import { deleteSession } from "./deleteSessionRepository";
import { logger } from '../../../lib/logger';
import { isAllowedAdminRole } from "../../middleware/roleAuth";
import { z } from "zod";

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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      // su.tenant_id (top-level claim) はクライアント制御可能なため使用しない
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";

      if (!isSuperAdmin && !jwtTenantId) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }

      const tenantFilter = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      // allowlist検証・クランプは chatHistoryRepository.normalizeSessionListParams に
      // 一本化している(agent の actionExecutor.ts と共有するため)。外部挙動は従来と同一。
      const normalized = normalizeSessionListParams({
        limit: req.query["limit"],
        offset: req.query["offset"],
        sort_by: req.query["sort_by"],
        sort_order: req.query["sort_order"],
        period: req.query["period"],
        sentiment: req.query["sentiment"],
      });
      const search = typeof req.query["search"] === "string" ? req.query["search"].trim() || undefined : undefined;

      try {
        const result = await getSessions({
          tenantId: tenantFilter,
          ...normalized,
          search,
        });

        return res.json({
          sessions: result.sessions,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        });
      } catch (err) {
        logger.warn("[GET /v1/admin/chat-history/sessions]", err);
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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      // su.tenant_id (top-level claim) はクライアント制御可能なため使用しない
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";

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
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
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
        logger.warn("[GET /v1/admin/chat-history/sessions/:id/messages]", err);
        return res.status(500).json({ error: "メッセージの取得に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/chat-history/sessions/:sessionId
  // Phase69-1: Right to Erasure — セッション完全削除
  // Body: { reason: string (5–500文字) }
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/chat-history/sessions/:sessionId",
    async (req: Request, res: Response) => {
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      // su.tenant_id (top-level claim) はクライアント制御可能なため使用しない
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      // セキュリティ要件: 認可ロールは app_metadata.role のみを信頼する
      // user_metadata はクライアント編集可能なため、特権判定に使用してはならない
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const actorEmail: string = su?.email ?? su?.app_metadata?.email ?? "";

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }

      // Phase69-1 fix [HIGH] Round2: client_admin は必ず有効な tenant_id を持つこと
      // JWT app_metadata が欠損/不正な場合でもクロステナント削除を防ぐ
      let scope: import("./deleteSessionRepository").DeleteSessionScope;
      if (actorRole === "client_admin") {
        if (!jwtTenantId || typeof jwtTenantId !== "string" || jwtTenantId.trim() === "") {
          return res.status(403).json({ error: "この操作を実行する権限がありません" });
        }
        scope = { kind: "tenant", tenantId: jwtTenantId };
      } else {
        // super_admin: スコープなし（全テナント対象）
        scope = { kind: "global" };
      }

      const { reason } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof reason !== "string" || reason.trim().length < 5) {
        return res.status(400).json({ error: "reason は5文字以上500文字以下の文字列が必要です" });
      }
      if (reason.trim().length > 500) {
        return res.status(400).json({ error: "reason は5文字以上500文字以下の文字列が必要です" });
      }
      const reasonValue = reason.trim();

      try {
        const result = await deleteSession({
          sessionDbId,
          scope,
          actorRole,
          actorEmail,
          reason: reasonValue,
        });

        if (!result) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }

        return res.json({
          deleted_session_id: result.deleted_session_id,
          affected_counts: result.affected_counts,
        });
      } catch (err) {
        // Phase69-1 fix [HIGH]: lock_timeout (55P03) → 409
        if ((err as { code?: string }).code === "55P03") {
          logger.warn({
            event: "chat_history_delete_lock_timeout",
            tenantId: jwtTenantId || "unknown",
            sessionId: sessionDbId,
            actorEmail: actorEmail || "unknown",
            errorCode: "55P03",
          }, "DELETE session lock timeout (3s exceeded)");
          return res.status(409).json({ error: "他の処理中のため、少し時間をおいて再度お試しください" });
        }
        logger.warn("[DELETE /v1/admin/chat-history/sessions/:id]", err);
        return res.status(500).json({ error: "セッションの削除に失敗しました" });
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
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      // su.tenant_id (top-level claim) はクライアント制御可能なため使用しない
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
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
        const conversionTypes = await getConversionTypes(session.tenant_id);
        if (!conversionTypes.includes(outcomeValue)) {
          return res.status(400).json({
            error: "指定されたoutcomeはこのテナントのconversion_typesに含まれていません",
            valid_outcomes: conversionTypes,
          });
        }

        // 記録 + 通知(検証・更新・通知の3点セットは recordOutcome() に集約。
        // agent の record_session_outcome ツールと同じ経路を通る)
        const recorded = await recordOutcome({
          sessionDbId,
          tenantId: session.tenant_id,
          outcome: outcomeValue,
          recordedBy: email || null,
        });

        return res.json({
          sessionId: sessionDbId,
          outcome: recorded.outcome,
          recorded_at: recorded.recordedAt,
          recorded_by: recorded.recordedBy,
        });
      } catch (err) {
        logger.warn("[PATCH /v1/admin/chat-history/sessions/:id/outcome]", err);
        return res.status(500).json({ error: "結果の記録に失敗しました" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // GID 1216275508391900: 有人チャットへのシームレスエスカレーション
  // -----------------------------------------------------------------------

  // GET /v1/admin/chat-history/escalations — 対応中(未解決)の一覧
  app.get(
    "/v1/admin/chat-history/escalations",
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && !jwtTenantId) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const tenantFilter = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      try {
        // limit を渡さないため従来どおり全件。レスポンスの形も従来と同一。
        const { escalations, total } = await getActiveEscalations(tenantFilter);
        return res.json({ escalations, total });
      } catch (err) {
        logger.warn("[GET /v1/admin/chat-history/escalations]", err);
        return res.status(500).json({ error: "一覧の取得に失敗しました" });
      }
    },
  );

  // POST /v1/admin/chat-history/sessions/:sessionId/reply — 有人オペレーターとして返信
  app.post(
    "/v1/admin/chat-history/sessions/:sessionId/reply",
    async (req: Request, res: Response) => {
      const pool = getPool();
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }

      const bodySchema = z.object({ content: z.string().min(1).max(2000) });
      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }

      try {
        const sessionResult = await pool.query<{ id: string; tenant_id: string; session_id: string }>(
          `SELECT id, tenant_id, session_id FROM chat_sessions WHERE id = $1`,
          [sessionDbId],
        );
        if (sessionResult.rowCount === 0) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }
        const session = sessionResult.rows[0];
        if (!isSuperAdmin && session.tenant_id !== jwtTenantId) {
          return res.status(403).json({ error: "このセッションへのアクセス権がありません" });
        }

        await saveMessage({
          tenantId: session.tenant_id,
          sessionId: session.session_id,
          role: "operator",
          content: parsed.data.content,
        });

        return res.status(201).json({ ok: true });
      } catch (err) {
        logger.warn("[POST /v1/admin/chat-history/sessions/:id/reply]", err);
        return res.status(500).json({ error: "返信の送信に失敗しました" });
      }
    },
  );

  // PATCH /v1/admin/chat-history/sessions/:sessionId/resolve-escalation — 対応完了にする
  app.patch(
    "/v1/admin/chat-history/sessions/:sessionId/resolve-escalation",
    async (req: Request, res: Response) => {
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
      const isSuperAdmin: boolean = actorRole === "super_admin";

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }

      try {
        const resolved = await resolveEscalation({
          sessionDbId,
          tenantId: isSuperAdmin ? undefined : jwtTenantId,
        });
        if (!resolved) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }
        return res.json({ ok: true });
      } catch (err) {
        logger.warn("[PATCH /v1/admin/chat-history/sessions/:id/resolve-escalation]", err);
        return res.status(500).json({ error: "対応完了の記録に失敗しました" });
      }
    },
  );
}
