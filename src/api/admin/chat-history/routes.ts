// src/api/admin/chat-history/routes.ts
// Phase38 Step2: 会話履歴取得API

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { getSessions, getMessages } from "./chatHistoryRepository";

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
      const jwtTenantId: string = (req as any).tenantId ?? "";
      const isSuperAdmin: boolean = (req as any).role === "super_admin";

      const tenantFilter = resolveTenantFilter(req, jwtTenantId, isSuperAdmin);

      const limit = Math.max(1, Math.min(parseInt((req.query["limit"] as string) ?? "50", 10) || 50, 200));
      const offset = Math.max(0, parseInt((req.query["offset"] as string) ?? "0", 10) || 0);

      try {
        const result = await getSessions({
          tenantId: tenantFilter,
          limit,
          offset,
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
      const jwtTenantId: string = (req as any).tenantId ?? "";
      const isSuperAdmin: boolean = (req as any).role === "super_admin";

      // テナント検証: super_admin は query ?tenant=xxx で指定、client_admin は自テナント
      const tenantId = isSuperAdmin
        ? ((req.query["tenant"] as string | undefined) ?? jwtTenantId)
        : jwtTenantId;

      if (!sessionDbId) {
        return res.status(400).json({ error: "sessionId が必要です" });
      }
      if (!tenantId) {
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
}
