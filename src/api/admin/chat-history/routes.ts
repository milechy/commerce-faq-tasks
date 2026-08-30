// src/api/admin/chat-history/routes.ts

// Phase38 Step2: 会話履歴取得API

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getPool } from "../../../lib/db";
import { getSessions, getMessages, getActiveEscalations, resolveEscalation, saveMessage, normalizeSessionListParams, normalizeEscalationSourceFilter, getConversionTypes, recordOutcome } from "./chatHistoryRepository";
import { deleteSession } from "./deleteSessionRepository";
import { exportVisitorData, deleteVisitorData } from "./visitorDataRepository";
import { logger } from '../../../lib/logger';
import { isAllowedAdminRole, roleAuthMiddleware } from "../../middleware/roleAuth";
import { z } from "zod";
import { getEvaluationsBySession } from "../evaluations/evaluationsRepository";
import { manuallyPromoteSession } from "../../../agent/memory/memoryDistiller";

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
  app.use("/v1/admin/chat-history", supabaseAuthMiddleware, roleAuthMiddleware);

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

        // null = セッションが存在しない（またはテナント不一致）。[] は「存在するが本文0件」で正常。
        if (messages === null) {
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
  // GDPR/個情法: visitor 単位のデータ開示(エクスポート)/削除
  //
  // visitor_id は (tenant_id, visitor_id) の複合でのみスコープする(単独では衝突する)。
  // そのため super_admin であっても tenant の特定を必須にする(?tenant=xxx)。指定なしは
  // 全テナントの同一 visitor_id を巻き込みかねないため 400 で弾く。
  // -----------------------------------------------------------------------

  // visitor スコープを解決する。解決できなければ { error, status } を返す。
  function resolveVisitorTenant(
    req: Request,
    actorRole: string | undefined,
  ): { tenantId: string } | { error: string; status: number } {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? "";
    const isSuperAdmin = actorRole === "super_admin";
    if (isSuperAdmin) {
      const fromQuery = (req.query["tenant"] as string | undefined) || "";
      if (!fromQuery.trim()) {
        return { error: "super_admin は tenant の指定が必須です(?tenant=xxx)", status: 400 };
      }
      return { tenantId: fromQuery.trim() };
    }
    if (!jwtTenantId || jwtTenantId.trim() === "") {
      return { error: "この操作を実行する権限がありません", status: 403 };
    }
    return { tenantId: jwtTenantId };
  }

  // GET /v1/admin/chat-history/visitors/:visitorId/export — 開示請求(JSON)
  app.get(
    "/v1/admin/chat-history/visitors/:visitorId/export",
    async (req: Request, res: Response) => {
      const visitorId: string = req.params["visitorId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      if (!visitorId.trim()) {
        return res.status(400).json({ error: "visitorId が必要です" });
      }
      const scope = resolveVisitorTenant(req, actorRole);
      if ("error" in scope) {
        return res.status(scope.status).json({ error: scope.error });
      }

      try {
        const result = await exportVisitorData({
          tenantId: scope.tenantId,
          visitorId: visitorId.trim(),
        });
        return res.json(result);
      } catch (err) {
        logger.warn("[GET /v1/admin/chat-history/visitors/:id/export]", err);
        return res.status(500).json({ error: "エクスポートに失敗しました" });
      }
    },
  );

  // DELETE /v1/admin/chat-history/visitors/:visitorId — 削除請求
  // Body: { reason: string (5–500文字) }
  app.delete(
    "/v1/admin/chat-history/visitors/:visitorId",
    async (req: Request, res: Response) => {
      const visitorId: string = req.params["visitorId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const actorEmail: string = su?.email ?? su?.app_metadata?.email ?? "";
      if (!visitorId.trim()) {
        return res.status(400).json({ error: "visitorId が必要です" });
      }
      const scope = resolveVisitorTenant(req, actorRole);
      if ("error" in scope) {
        return res.status(scope.status).json({ error: scope.error });
      }

      const { reason } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 500) {
        return res.status(400).json({ error: "reason は5文字以上500文字以下の文字列が必要です" });
      }

      try {
        const result = await deleteVisitorData({
          tenantId: scope.tenantId,
          visitorId: visitorId.trim(),
          actorRole,
          actorEmail,
          reason: reason.trim(),
        });
        return res.json(result);
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") {
          return res.status(409).json({ error: "他の処理中のため、少し時間をおいて再度お試しください" });
        }
        logger.warn("[DELETE /v1/admin/chat-history/visitors/:id]", err);
        return res.status(500).json({ error: "削除に失敗しました" });
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

        if (!recorded) {
          // 直前のSELECTでは存在確認済みのため通常到達しないが、
          // 競合(削除)に備えて「無い」を「空」と区別して返す(CLAUDE.md 禁止20)。
          return res.status(404).json({ error: "セッションが見つかりません" });
        }

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
  // POST /v1/admin/chat-history/sessions/:sessionId/promote-memory
  // GID 1217972798328871 (H-6): 学習ループの初期母数(90日で13会話)が
  // 自動昇格ゲート(スコア閾値80 + CV/outcome必須)を満たせないまま枯渇しているため、
  // super_adminが個別に確認した会話を手動で learned_memory へ昇格する経路。
  // 自動昇格のゲート自体(memoryDistiller.distillAndPromote)は変更しない。
  // :sessionId = chat_sessions.id (UUID。他エンドポイントと同じ規約)
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/chat-history/sessions/:sessionId/promote-memory",
    async (req: Request, res: Response) => {
      const pool = getPool();
      const sessionDbId: string = req.params["sessionId"] ?? "";
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;

      // 学習メモリへの昇格は super_admin 限定の運用操作(旧UI)。client_admin には出さない。
      // UI側の出し分けだけでなくサーバ側でも強制する(CLAUDE.md 禁止14: 機能ゲートをUI側だけに置かない)。
      if (actorRole !== "super_admin") {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }

      // previewMode中は ?tenant= でスコープを絞る(resolveTenantFilter と同じ規約)。
      // 未指定なら全テナント対象(super_adminの通常運用)。
      const tenantFilter = (req.query["tenant"] as string | undefined) || undefined;

      try {
        // テナント越境は「見つからない」に倒す(CLAUDE.md 禁止20・24。存在確認オラクル防止)。
        const sessionResult = tenantFilter
          ? await pool.query<{ id: string; tenant_id: string; session_id: string }>(
              `SELECT id, tenant_id, session_id FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
              [sessionDbId, tenantFilter],
            )
          : await pool.query<{ id: string; tenant_id: string; session_id: string }>(
              `SELECT id, tenant_id, session_id FROM chat_sessions WHERE id = $1`,
              [sessionDbId],
            );
        if (sessionResult.rows.length === 0) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }
        const session = sessionResult.rows[0];

        const messages = await getMessages({ sessionDbId, tenantId: session.tenant_id });
        if (messages === null) {
          return res.status(404).json({ error: "セッションが見つかりません" });
        }

        // 蒸留時の judge_score は参考値として既存のJudge評価があれば使う(無ければ0)。
        // conversation_evaluations.session_id は chat_sessions.session_id(公開キー)で
        // 記録されている(judgeEvaluator.ts)。session.id(内部UUID)を渡すと常に0件になるため
        // 必ず session.session_id を渡す。
        const evaluations = await getEvaluationsBySession(session.session_id, session.tenant_id);
        const judgeScore = evaluations[0]?.overall_score ?? 0;

        // distillAndPromote(自動)と同じ (tenant_id, source_session_id) キーで重複判定させるため、
        // DBの内部id ではなく公開 session_id を渡す(自動昇格済みセッションへの二重昇格を防ぐ)。
        const result = await manuallyPromoteSession({
          tenantId: session.tenant_id,
          sessionId: session.session_id,
          judgeScore,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });

        if (result.promoted) {
          return res.json({ promoted: true });
        }

        // 失敗を黙って成功にしない: 昇格済み/抽出不可/対象外を区別して伝える。
        const REASON_MESSAGES: Record<typeof result.reason, string> = {
          already_promoted: "この会話は既に学習メモリに昇格済みです",
          no_qa_extracted: "有用な質問と回答の組を抽出できませんでした",
          too_few_messages: "メッセージ数が少なく蒸留対象になりません",
          disabled: "学習メモリ機能が現在無効になっています",
        };
        return res.json({
          promoted: false,
          reason: result.reason,
          message: REASON_MESSAGES[result.reason],
        });
      } catch (err) {
        logger.warn("[POST /v1/admin/chat-history/sessions/:id/promote-memory]", err);
        return res.status(500).json({ error: "学習メモリへの昇格に失敗しました" });
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
      // 未指定/不正値は既定の 'user' にフォールバックする(安全側)。'all' のときだけ全件。
      const source = normalizeEscalationSourceFilter(req.query["source"]);

      try {
        // limit を渡さないため従来どおり全件。レスポンスの形も従来と同一。
        const { escalations, total } = await getActiveEscalations(tenantFilter, undefined, source);
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
